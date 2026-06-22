import {
  BlobSASPermissions,
  BlobServiceClient,
  StorageSharedKeyCredential,
  type BlobHTTPHeaders,
  type BlobItem,
  type BlockBlobClient,
  type ContainerClient,
} from "@azure/storage-blob";

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

export interface AzureDriverOptions extends DriverOptions {
  /** The blob container every operation targets. */
  container: string;
  /** Connection string (Node). The simplest path for shared-key auth + Azurite. */
  connectionString?: string;
  /** Account name — pair with `accountKey` for shared-key auth (Node). */
  account?: string;
  /** Shared account key (Node only — never ship to the browser). */
  accountKey?: string;
  /**
   * A full service SAS URL. The browser-safe path: scoped, short-lived, and
   * carries no account key. SAS-built clients cannot generate further SAS tokens.
   */
  sasUrl?: string;
  /** Escape hatch: bring your own configured `BlobServiceClient`. */
  serviceClient?: BlobServiceClient;
}

/** Drain a Node `Readable` into a single `Uint8Array` (the Node download branch). */
async function streamToBytes(stream: NodeJS.ReadableStream): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer | string>) {
    const part =
      typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(part);
    total += part.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function azStatus(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

/**
 * Azure Blob Storage driver. A distinct SDK from S3 but the same key-native
 * paradigm: the canonical path is the blob name and `resolveNativeId` returns it.
 * Isomorphic — `@azure/storage-blob` ships a browser bundle; the one runtime fork
 * is the download body shape (`readableStreamBody` in Node, `blobBody` in browser).
 */
export class AzureBlobDriver extends BaseDriver<BlobServiceClient> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.SignedUrl,
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>([
    "node",
    "browser",
  ]);

  private readonly containerName: string;
  private readonly service: BlobServiceClient;

  constructor(options: AzureDriverOptions) {
    super(options);
    this.containerName = options.container;
    this.service = AzureBlobDriver.buildClient(options);
  }

  private static buildClient(options: AzureDriverOptions): BlobServiceClient {
    if (options.serviceClient) return options.serviceClient;
    if (options.connectionString) {
      return BlobServiceClient.fromConnectionString(options.connectionString);
    }
    if (options.account && options.accountKey) {
      const credential = new StorageSharedKeyCredential(
        options.account,
        options.accountKey,
      );
      return new BlobServiceClient(
        `https://${options.account}.blob.core.windows.net`,
        credential,
      );
    }
    if (options.sasUrl) return new BlobServiceClient(options.sasUrl);
    throw new StorageError(
      "AzureBlobDriver needs one of: connectionString, account+accountKey, sasUrl, or serviceClient",
      "AUTH",
    );
  }

  get native(): BlobServiceClient {
    return this.service;
  }

  private get container(): ContainerClient {
    return this.service.getContainerClient(this.containerName);
  }

  private blobFor(key: string): BlockBlobClient {
    return this.container.getBlockBlobClient(key);
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false && (await this.blobFor(key).exists())) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const bytes = await toBytes(data);
    try {
      await this.blobFor(key).uploadData(bytes, this.uploadOptions(opts?.contentType, opts?.metadata));
    } catch (error) {
      throw this.mapError(error, path);
    }
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: bytes.byteLength,
      modifiedAt: new Date(),
    };
    if (opts?.metadata !== undefined) entry.metadata = opts.metadata;
    return entry;
  }

  async get(path: string): Promise<Uint8Array> {
    return this.downloadByKey(this.resolve(path), path);
  }

  private async downloadByKey(key: string, path: string): Promise<Uint8Array> {
    try {
      const dl = await this.blobFor(key).download();
      // The one isomorphism fork: Node yields a Readable, the browser a Blob.
      if (typeof window === "undefined") {
        return await streamToBytes(dl.readableStreamBody!);
      }
      return new Uint8Array(await (await dl.blobBody!).arrayBuffer());
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const azPrefix = scope ? `${scope}/` : "";
    const limit = opts?.limit;
    let count = 0;

    if (recursive) {
      for await (const blob of this.container.listBlobsFlat(
        azPrefix ? { prefix: azPrefix } : {},
      )) {
        if (blob.name === azPrefix) continue;
        if (limit !== undefined && count >= limit) return;
        yield this.entryForBlob(blob);
        count++;
      }
      return;
    }

    for await (const item of this.container.listBlobsByHierarchy(
      "/",
      azPrefix ? { prefix: azPrefix } : {},
    )) {
      if (limit !== undefined && count >= limit) return;
      if (item.kind === "prefix") {
        const dirKey = item.name.replace(/\/$/, "");
        const dirPath = this.unresolve(dirKey);
        yield { path: dirPath, name: basename(dirPath), type: "directory" };
      } else {
        if (item.name === azPrefix) continue;
        yield this.entryForBlob(item);
      }
      count++;
    }
  }

  async delete(path: string): Promise<void> {
    // Idempotent: deleteIfExists matches object-store delete semantics.
    try {
      await this.blobFor(this.resolve(path)).deleteIfExists();
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.blobFor(this.resolve(path)).exists();
  }

  async resolveNativeId(path: string): Promise<string> {
    // Key-native: the resolved blob name is the native identifier.
    return this.resolve(path);
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const srcKey = this.resolve(from);
    const dstKey = this.resolve(to);
    let properties;
    try {
      properties = await this.blobFor(srcKey).getProperties();
    } catch (error) {
      throw this.mapError(error, from);
    }
    // Portable copy: download + re-upload preserving content type and metadata.
    // (Server-side syncCopyFromURL is a Phase 5 optimization.)
    const bytes = await this.downloadByKey(srcKey, from);
    const custom =
      properties.metadata && Object.keys(properties.metadata).length > 0
        ? (properties.metadata as Record<string, string>)
        : undefined;
    await this.blobFor(dstKey).uploadData(
      bytes,
      this.uploadOptions(properties.contentType, custom),
    );
    return this.stat(to);
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const entry = await this.copy(from, to);
    await this.delete(from);
    return entry;
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    let properties;
    try {
      properties = await this.blobFor(key).getProperties();
    } catch (error) {
      throw this.mapError(error, path);
    }
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: properties.contentLength ?? 0,
    };
    if (properties.lastModified) entry.modifiedAt = properties.lastModified;
    if (properties.etag) entry.etag = properties.etag;
    const custom = properties.metadata as Record<string, string> | undefined;
    if (custom && Object.keys(custom).length > 0) entry.metadata = custom;
    return entry;
  }

  async getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    const key = this.resolve(path);
    const expiresIn = opts?.expiresIn ?? 900;
    return this.blobFor(key).generateSasUrl({
      permissions: BlobSASPermissions.parse(opts?.action === "write" ? "w" : "r"),
      expiresOn: new Date(Date.now() + expiresIn * 1000),
    });
  }

  /** Build the SDK upload options, omitting absent fields (exactOptionalPropertyTypes). */
  private uploadOptions(
    contentType: string | undefined,
    metadata: Record<string, string> | undefined,
  ): { blobHTTPHeaders?: BlobHTTPHeaders; metadata?: Record<string, string> } {
    const options: { blobHTTPHeaders?: BlobHTTPHeaders; metadata?: Record<string, string> } =
      {};
    if (contentType !== undefined) options.blobHTTPHeaders = { blobContentType: contentType };
    if (metadata !== undefined) options.metadata = metadata;
    return options;
  }

  private entryForBlob(blob: BlobItem): StorageEntry {
    const objectPath = this.unresolve(blob.name);
    const props = blob.properties;
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: props.contentLength ?? 0,
    };
    if (props.lastModified) entry.modifiedAt = props.lastModified;
    if (props.etag) entry.etag = props.etag;
    return entry;
  }

  /** Map an Azure SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const status = azStatus(error);
    if (status === 404) return new NotFoundError(`No object found at "${path}"`);
    if (status === 409) return new AlreadyExistsError(`Object already exists at "${path}"`);
    if (status === 403) {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    if (status === 401) {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`Azure operation failed for "${path}"`, "UNKNOWN");
  }
}
