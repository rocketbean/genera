import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  paginateListObjectsV2,
  PutObjectCommand,
  S3Client,
  type HeadObjectCommandOutput,
  type S3ClientConfig,
  type _Object as S3Object,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { Upload } from "@aws-sdk/lib-storage";

import {
  AlreadyExistsError,
  AuthError,
  BaseDriver,
  Capability,
  NotFoundError,
  PermissionError,
  RateLimitError,
  StorageError,
  UnavailableError,
  basename,
  toBytes,
  type CredentialProvider,
  type DriverOptions,
  type Environment,
  type ListOptions,
  type PutData,
  type PutOptions,
  type SignedUrlOptions,
  type StorageEntry,
} from "@rocketbean/genera";

/** The credential payload an S3-compatible provider needs (the `CredentialProvider` seam). */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** For temporary/STS credentials. */
  sessionToken?: string;
}

export interface S3DriverOptions extends DriverOptions {
  /** The bucket every operation targets. */
  bucket: string;
  /** AWS: the real region. R2: "auto". MinIO/others: any value the endpoint accepts. */
  region?: string;
  /** Omit for AWS; set for every S3-compatible provider (R2, Spaces, MinIO, …). */
  endpoint?: string;
  /** Path-style addressing. Required by MinIO/R2/B2/Wasabi/IDrive; optional for AWS/Spaces. */
  forcePathStyle?: boolean;
  /**
   * Credentials via the Genera auth seam. Wrap static keys with `staticCredentials({...})`.
   * The SDK calls the provider on demand, so refreshing providers work transparently.
   */
  credentials?: CredentialProvider<S3Credentials>;
  /**
   * Escape hatch: bring your own fully-configured `S3Client`. When set, `region`,
   * `endpoint`, `forcePathStyle`, and `credentials` are ignored.
   */
  client?: S3Client;
}

/** Narrow an unknown SDK error to its HTTP status code, if present. */
function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | undefined)?.$metadata
    ?.httpStatusCode;
}

function errorName(error: unknown): string {
  return (error as { name?: string } | undefined)?.name ?? "";
}

function isNotFound(error: unknown): boolean {
  return (
    httpStatus(error) === 404 ||
    errorName(error) === "NoSuchKey" ||
    errorName(error) === "NotFound"
  );
}

/**
 * The S3-compatible driver — one driver for AWS S3, Cloudflare R2, DigitalOcean
 * Spaces, Backblaze B2, Wasabi, MinIO, and IDrive e2. They differ only in client
 * config (endpoint / region / forcePathStyle).
 *
 * Key-native: the canonical (root-scoped) path *is* the object key, so
 * `resolveNativeId` returns it directly. The underlying `S3Client` is the `native`
 * escape hatch.
 */
export class S3Driver extends BaseDriver<S3Client> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.SignedUrl,
    Capability.Stream,
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
  ]);

  /** Bodies at or above this size (or any stream) go through multipart upload. */
  private static readonly MULTIPART_THRESHOLD = 5 * 1024 * 1024;
  // The AWS SDK v3 is isomorphic; `Body.transformToByteArray()` works in both runtimes.
  readonly environments: ReadonlySet<Environment> = new Set<Environment>([
    "node",
    "browser",
  ]);

  private readonly bucket: string;
  private readonly client: S3Client;

  constructor(options: S3DriverOptions) {
    super(options);
    this.bucket = options.bucket;
    this.client = options.client ?? S3Driver.buildClient(options);
  }

  private static buildClient(options: S3DriverOptions): S3Client {
    const config: S3ClientConfig = {};
    if (options.region !== undefined) config.region = options.region;
    if (options.endpoint !== undefined) config.endpoint = options.endpoint;
    if (options.forcePathStyle !== undefined) config.forcePathStyle = options.forcePathStyle;
    if (options.credentials) {
      const provider = options.credentials;
      // Adapt the Genera seam into the SDK's async credential provider so refresh
      // logic (if any) lives entirely in the provider.
      config.credentials = async () => {
        const c = await provider.getCredential();
        return {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken !== undefined ? { sessionToken: c.sessionToken } : {}),
        };
      };
    }
    return new S3Client(config);
  }

  get native(): S3Client {
    return this.client;
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false && (await this.headKey(key)) !== undefined) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }

    // Streams upload via multipart without buffering the whole payload; the
    // resulting size is unknown up front, so report it from a follow-up stat.
    if (data instanceof ReadableStream) {
      await this.multipartUpload(key, data, opts, path);
      return this.stat(path);
    }

    const body = await toBytes(data);
    try {
      if (body.byteLength >= S3Driver.MULTIPART_THRESHOLD) {
        await this.multipartUpload(key, body, opts, path);
      } else {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: body,
            ...(opts?.contentType !== undefined ? { ContentType: opts.contentType } : {}),
            ...(opts?.metadata !== undefined ? { Metadata: opts.metadata } : {}),
          }),
        );
      }
    } catch (error) {
      throw this.mapError(error, path);
    }
    const entry: StorageEntry = {
      path: this.unresolve(key),
      name: basename(this.unresolve(key)),
      type: "file",
      size: body.byteLength,
      modifiedAt: new Date(),
    };
    if (opts?.metadata !== undefined) entry.metadata = opts.metadata;
    return entry;
  }

  /**
   * Multipart upload via `@aws-sdk/lib-storage` (`Capability.Stream`). Handles both
   * `ReadableStream` bodies and large buffers, chunking automatically.
   */
  private async multipartUpload(
    key: string,
    body: Uint8Array | ReadableStream,
    opts: PutOptions | undefined,
    path: string,
  ): Promise<void> {
    try {
      const upload = new Upload({
        client: this.client,
        params: {
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ...(opts?.contentType !== undefined ? { ContentType: opts.contentType } : {}),
          ...(opts?.metadata !== undefined ? { Metadata: opts.metadata } : {}),
        },
      });
      await upload.done();
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const key = this.resolve(path);
    try {
      const out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      // The sdk-stream-mixin makes this isomorphic — no `instanceof Readable` branch.
      return await out.Body!.transformToByteArray();
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const s3Prefix = scope ? `${scope}/` : "";
    const limit = opts?.limit;

    let count = 0;
    for await (const page of paginateListObjectsV2(
      { client: this.client },
      {
        Bucket: this.bucket,
        ...(s3Prefix ? { Prefix: s3Prefix } : {}),
        ...(recursive ? {} : { Delimiter: "/" }),
      },
    )) {
      if (!recursive) {
        for (const cp of page.CommonPrefixes ?? []) {
          if (limit !== undefined && count >= limit) return;
          // CommonPrefix looks like "scope/dir/" — strip the trailing slash.
          const dirKey = cp.Prefix!.replace(/\/$/, "");
          const dirPath = this.unresolve(dirKey);
          yield { path: dirPath, name: basename(dirPath), type: "directory" };
          count++;
        }
      }
      for (const object of page.Contents ?? []) {
        // Skip the folder placeholder object some tools create (key === the prefix).
        if (object.Key === undefined || object.Key === s3Prefix) continue;
        if (limit !== undefined && count >= limit) return;
        yield this.entryForObject(object);
        count++;
      }
    }
  }

  async delete(path: string): Promise<void> {
    // Idempotent: S3 DeleteObject succeeds even when the key is absent.
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: this.resolve(path) }),
      );
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    return (await this.headKey(this.resolve(path))) !== undefined;
  }

  async resolveNativeId(path: string): Promise<string> {
    // Key-native: the resolved object key is the native identifier.
    return this.resolve(path);
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const fromKey = this.resolve(from);
    const toKey = this.resolve(to);
    try {
      await this.client.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          // CopySource must be URL-encoded per segment, keeping the slashes literal.
          CopySource: `${this.bucket}/${fromKey}`
            .split("/")
            .map(encodeURIComponent)
            .join("/"),
          Key: toKey,
        }),
      );
    } catch (error) {
      throw this.mapError(error, from);
    }
    return this.stat(to);
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const entry = await this.copy(from, to);
    await this.delete(from);
    return entry;
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    const head = await this.headKey(key);
    if (head === undefined) {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: head.ContentLength ?? 0,
    };
    if (head.LastModified) entry.modifiedAt = head.LastModified;
    if (head.ETag) entry.etag = head.ETag;
    if (head.Metadata && Object.keys(head.Metadata).length > 0) {
      entry.metadata = head.Metadata;
    }
    return entry;
  }

  async getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    const key = this.resolve(path);
    const expiresIn = opts?.expiresIn ?? 900;
    const command =
      opts?.action === "write"
        ? new PutObjectCommand({ Bucket: this.bucket, Key: key })
        : new GetObjectCommand({ Bucket: this.bucket, Key: key });
    return getSignedUrl(this.client, command, { expiresIn });
  }

  /** HEAD a key, returning its metadata or `undefined` when it does not exist. */
  private async headKey(key: string): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw this.mapError(error, key);
    }
  }

  private entryForObject(object: S3Object): StorageEntry {
    const objectPath = this.unresolve(object.Key!);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: object.Size ?? 0,
    };
    if (object.LastModified) entry.modifiedAt = object.LastModified;
    if (object.ETag) entry.etag = object.ETag;
    return entry;
  }

  /** Map an AWS SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    if (isNotFound(error)) return new NotFoundError(`No object found at "${path}"`);
    const status = httpStatus(error);
    const name = errorName(error);
    if (status === 429 || name === "SlowDown" || name === "TooManyRequests") {
      return new RateLimitError(`Rate limited for "${path}"`, undefined, { cause: error });
    }
    if (status === 503 || status === 502 || status === 504 || name === "ServiceUnavailable") {
      return new UnavailableError(`Service unavailable for "${path}"`, { cause: error });
    }
    if (status === 403 || name === "AccessDenied") {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    if (
      status === 401 ||
      name === "InvalidAccessKeyId" ||
      name === "SignatureDoesNotMatch"
    ) {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`S3 operation failed for "${path}"`, "UNKNOWN");
  }
}
