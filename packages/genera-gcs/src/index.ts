import {
  Storage,
  type Bucket,
  type File,
  type SaveOptions,
  type StorageOptions,
} from "@google-cloud/storage";

import {
  AlreadyExistsError,
  AuthError,
  BaseDriver,
  Capability,
  NotFoundError,
  PermissionError,
  StorageError,
  basename,
  toBytes,
  type DriverOptions,
  type Environment,
  type ListOptions,
  type PutData,
  type PutOptions,
  type SignedUrlOptions,
  type StorageEntry,
} from "@rocketbean/genera";

/** A service-account key pair, when not relying on Application Default Credentials. */
export interface GcsServiceAccount {
  client_email: string;
  private_key: string;
}

export interface GcsDriverOptions extends DriverOptions {
  /** The bucket every operation targets. */
  bucket: string;
  /** GCP project id. Optional when ADC provides it. */
  projectId?: string;
  /** Custom API endpoint — set to the fake-gcs-server URL for emulator tests. */
  apiEndpoint?: string;
  /**
   * Explicit service-account credentials. Omit to use Application Default
   * Credentials (GOOGLE_APPLICATION_CREDENTIALS / metadata server). The GCS SDK
   * constructs synchronously, so this is a static value rather than the async
   * `CredentialProvider` seam (rotating-credential/OAuth lives in S3 + Tier 2).
   */
  credentials?: GcsServiceAccount;
  /** Path to a service-account JSON key file (alternative to `credentials`). */
  keyFilename?: string;
  /** Escape hatch: bring your own configured `Storage` client. */
  storage?: Storage;
}

function gcsStatus(error: unknown): number | undefined {
  return (error as { code?: number } | undefined)?.code;
}

/**
 * Google Cloud Storage driver. Key-native like S3 (the canonical path is the
 * object name; `resolveNativeId` returns it directly), but **Node-only** — the
 * `@google-cloud/storage` SDK pulls in Node built-ins and ships no browser bundle.
 * For the browser, route through the S3-compatible endpoint or a server-generated
 * signed URL (plan §5.6).
 */
export class GcsDriver extends BaseDriver<Storage> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.SignedUrl,
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>(["node"]);

  private readonly bucketName: string;
  private readonly storage: Storage;

  constructor(options: GcsDriverOptions) {
    super(options);
    this.bucketName = options.bucket;
    this.storage = options.storage ?? GcsDriver.buildClient(options);
  }

  private static buildClient(options: GcsDriverOptions): Storage {
    const config: StorageOptions = {};
    if (options.projectId !== undefined) config.projectId = options.projectId;
    if (options.apiEndpoint !== undefined) config.apiEndpoint = options.apiEndpoint;
    if (options.credentials !== undefined) config.credentials = options.credentials;
    if (options.keyFilename !== undefined) config.keyFilename = options.keyFilename;
    return new Storage(config);
  }

  get native(): Storage {
    return this.storage;
  }

  private get bucket(): Bucket {
    return this.storage.bucket(this.bucketName);
  }

  private fileFor(key: string): File {
    return this.bucket.file(key);
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false) {
      const [exists] = await this.fileFor(key).exists();
      if (exists) throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const body = Buffer.from(await toBytes(data));
    const saveOptions: SaveOptions = { resumable: false };
    if (opts?.contentType !== undefined) saveOptions.contentType = opts.contentType;
    if (opts?.metadata !== undefined) saveOptions.metadata = { metadata: opts.metadata };
    try {
      await this.fileFor(key).save(body, saveOptions);
    } catch (error) {
      throw this.mapError(error, path);
    }
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: body.byteLength,
      modifiedAt: new Date(),
    };
    if (opts?.metadata !== undefined) entry.metadata = opts.metadata;
    return entry;
  }

  async get(path: string): Promise<Uint8Array> {
    try {
      const [buffer] = await this.fileFor(this.resolve(path)).download();
      return new Uint8Array(buffer);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const gcsPrefix = scope ? `${scope}/` : "";
    const limit = opts?.limit;

    let count = 0;
    let pageToken: string | undefined;
    do {
      const [files, nextQuery, apiResponse] = await this.bucket.getFiles({
        autoPaginate: false,
        ...(gcsPrefix ? { prefix: gcsPrefix } : {}),
        ...(recursive ? {} : { delimiter: "/" }),
        ...(pageToken ? { pageToken } : {}),
      });

      if (!recursive) {
        const prefixes = (apiResponse as { prefixes?: string[] } | undefined)?.prefixes ?? [];
        for (const dir of prefixes) {
          if (limit !== undefined && count >= limit) return;
          const dirKey = dir.replace(/\/$/, "");
          const dirPath = this.unresolve(dirKey);
          yield { path: dirPath, name: basename(dirPath), type: "directory" };
          count++;
        }
      }

      for (const file of files) {
        // Skip the placeholder object some tools create for a "folder".
        if (file.name === gcsPrefix) continue;
        if (limit !== undefined && count >= limit) return;
        yield this.entryForFile(file);
        count++;
      }

      pageToken = (nextQuery as { pageToken?: string } | null)?.pageToken;
    } while (pageToken);
  }

  async delete(path: string): Promise<void> {
    // Idempotent: ignoreNotFound matches object-store delete semantics.
    try {
      await this.fileFor(this.resolve(path)).delete({ ignoreNotFound: true });
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    const [exists] = await this.fileFor(this.resolve(path)).exists();
    return exists;
  }

  async resolveNativeId(path: string): Promise<string> {
    // Key-native: the resolved object name is the native identifier.
    return this.resolve(path);
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const toKey = this.resolve(to);
    try {
      await this.fileFor(this.resolve(from)).copy(this.fileFor(toKey));
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
    let metadata;
    try {
      [metadata] = await this.fileFor(key).getMetadata();
    } catch (error) {
      throw this.mapError(error, path);
    }
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: Number(metadata.size ?? 0),
    };
    if (metadata.updated) entry.modifiedAt = new Date(metadata.updated);
    if (metadata.etag) entry.etag = metadata.etag;
    const custom = metadata.metadata as Record<string, string> | undefined;
    if (custom && Object.keys(custom).length > 0) entry.metadata = custom;
    return entry;
  }

  async getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    const key = this.resolve(path);
    const expiresIn = opts?.expiresIn ?? 900;
    const [url] = await this.fileFor(key).getSignedUrl({
      version: "v4",
      action: opts?.action === "write" ? "write" : "read",
      expires: Date.now() + expiresIn * 1000,
    });
    return url;
  }

  private entryForFile(file: File): StorageEntry {
    const objectPath = this.unresolve(file.name);
    const md = file.metadata;
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: Number(md.size ?? 0),
    };
    if (md.updated) entry.modifiedAt = new Date(md.updated);
    if (md.etag) entry.etag = md.etag;
    return entry;
  }

  /** Map a GCS SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const status = gcsStatus(error);
    if (status === 404) return new NotFoundError(`No object found at "${path}"`);
    if (status === 403) {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    if (status === 401) {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`GCS operation failed for "${path}"`, "UNKNOWN");
  }
}
