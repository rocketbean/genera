import { Dropbox, type files } from "dropbox";

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
  toBytes,
  type CredentialProvider,
  type DriverOptions,
  type Environment,
  type ListOptions,
  type OAuthCredential,
  type PutData,
  type PutOptions,
  type SignedUrlOptions,
  type StorageEntry,
} from "@rocketbean/genera";

export interface DropboxDriverOptions extends DriverOptions {
  /** OAuth credential provider yielding a fresh access token per request. */
  credentials?: CredentialProvider<OAuthCredential>;
  /** A static access token — simplest, but it will expire. Prefer `credentials`. */
  accessToken?: string;
  /** Escape hatch (and test seam): bring your own configured Dropbox client. */
  client?: Dropbox;
}

/** A download response carries the bytes differently by runtime. */
type DownloadResult = files.FileMetadata & { fileBinary?: Uint8Array; fileBlob?: Blob };

function dropboxError(error: unknown): { status: number | undefined; summary: string } {
  const e = error as { status?: number; error?: { error_summary?: string } };
  return { status: e.status, summary: e.error?.error_summary ?? "" };
}

function isPathNotFound(error: unknown): boolean {
  return dropboxError(error).summary.includes("not_found");
}

/**
 * Dropbox driver — a **path-native** Tier 2 provider: Dropbox already speaks
 * paths, so the only translation is the leading slash (Genera canonical paths
 * have none; Dropbox wants one, and `""` for the account root). Isomorphic; the
 * one runtime fork is the download body (`fileBinary` in Node, `fileBlob` in the
 * browser). Auth comes from an `OAuthCredentialProvider` (plan Phase 3).
 */
export class DropboxDriver extends BaseDriver<Dropbox> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.SignedUrl,
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
    Capability.CreateDirectory,
    Capability.DeleteDirectory,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>([
    "node",
    "browser",
  ]);

  private readonly options: DropboxDriverOptions;
  private dbx: Dropbox;

  constructor(options: DropboxDriverOptions) {
    super(options);
    if (!options.client && !options.accessToken && !options.credentials) {
      throw new StorageError(
        "DropboxDriver needs one of: credentials, accessToken, or client",
        "AUTH",
      );
    }
    this.options = options;
    this.dbx =
      options.client ??
      new Dropbox(options.accessToken ? { accessToken: options.accessToken } : {});
  }

  get native(): Dropbox {
    return this.dbx;
  }

  /** Refresh the access token from the OAuth provider (if configured), then return the client. */
  private async client(): Promise<Dropbox> {
    if (!this.options.client && this.options.credentials) {
      const { accessToken } = await this.options.credentials.getCredential();
      this.dbx = new Dropbox({ accessToken });
    }
    return this.dbx;
  }

  /** Canonical (root-scoped) key -> Dropbox path ("" is the account root). */
  private toDropboxPath(key: string): string {
    return key === "" ? "" : `/${key}`;
  }

  /** Dropbox path ("/a/b.txt") -> canonical user-facing path. */
  private toUserPath(dropboxPath: string): string {
    return this.unresolve(dropboxPath.replace(/^\//, ""));
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false && (await this.exists(path))) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const dbx = await this.client();
    try {
      const { result } = await dbx.filesUpload({
        path: this.toDropboxPath(key),
        contents: await toBytes(data),
        mode: { ".tag": "overwrite" },
      });
      return this.entryForFile(result);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const dbx = await this.client();
    try {
      const { result } = await dbx.filesDownload({
        path: this.toDropboxPath(this.resolve(path)),
      });
      const download = result as DownloadResult;
      // Node yields a Buffer (`fileBinary`); the browser a `fileBlob`.
      if (download.fileBinary !== undefined) return new Uint8Array(download.fileBinary);
      if (download.fileBlob) return new Uint8Array(await download.fileBlob.arrayBuffer());
      throw new StorageError(`Dropbox download for "${path}" returned no body`, "UNKNOWN");
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const limit = opts?.limit;
    const dbx = await this.client();

    let count = 0;
    let response = await dbx.filesListFolder({
      path: this.toDropboxPath(scope),
      recursive,
    });
    for (;;) {
      for (const entry of response.result.entries) {
        if (entry[".tag"] === "deleted") continue;
        if (limit !== undefined && count >= limit) return;
        yield entry[".tag"] === "folder"
          ? {
              path: this.toUserPath(entry.path_display ?? `/${entry.name}`),
              name: entry.name,
              type: "directory",
            }
          : this.entryForFile(entry);
        count++;
      }
      if (!response.result.has_more) break;
      response = await dbx.filesListFolderContinue({ cursor: response.result.cursor });
    }
  }

  async delete(path: string): Promise<void> {
    const dbx = await this.client();
    try {
      await dbx.filesDeleteV2({ path: this.toDropboxPath(this.resolve(path)) });
    } catch (error) {
      // Idempotent: a missing path is a no-op.
      if (!isPathNotFound(error)) throw this.mapError(error, path);
    }
  }

  async exists(path: string): Promise<boolean> {
    const dbx = await this.client();
    try {
      await dbx.filesGetMetadata({ path: this.toDropboxPath(this.resolve(path)) });
      return true;
    } catch (error) {
      if (isPathNotFound(error)) return false;
      throw this.mapError(error, path);
    }
  }

  async resolveNativeId(path: string): Promise<string> {
    // Path-native: the Dropbox path is the native identifier.
    return this.toDropboxPath(this.resolve(path));
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const dbx = await this.client();
    try {
      const { result } = await dbx.filesCopyV2({
        from_path: this.toDropboxPath(this.resolve(from)),
        to_path: this.toDropboxPath(this.resolve(to)),
      });
      return this.entryForMetadata(result.metadata);
    } catch (error) {
      throw this.mapError(error, from);
    }
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const dbx = await this.client();
    try {
      const { result } = await dbx.filesMoveV2({
        from_path: this.toDropboxPath(this.resolve(from)),
        to_path: this.toDropboxPath(this.resolve(to)),
      });
      return this.entryForMetadata(result.metadata);
    } catch (error) {
      throw this.mapError(error, from);
    }
  }

  async stat(path: string): Promise<StorageEntry> {
    const dbx = await this.client();
    try {
      const { result } = await dbx.filesGetMetadata({
        path: this.toDropboxPath(this.resolve(path)),
      });
      return this.entryForMetadata(result);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async createDirectory(path: string): Promise<void> {
    const dbx = await this.client();
    try {
      await dbx.filesCreateFolderV2({ path: this.toDropboxPath(this.resolve(path)) });
    } catch (error) {
      // Treat an existing folder as success.
      if (!dropboxError(error).summary.includes("conflict")) throw this.mapError(error, path);
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    const dbx = await this.client();
    try {
      await dbx.filesDeleteV2({ path: this.toDropboxPath(this.resolve(path)) });
    } catch (error) {
      if (!isPathNotFound(error)) throw this.mapError(error, path);
    }
  }

  /**
   * A Dropbox shared link. Note the semantic difference from S3/GCS/Azure: this is
   * a shareable link, **not** a time-limited presigned URL (`expiresIn` is ignored).
   */
  async getSignedUrl(path: string, _opts?: SignedUrlOptions): Promise<string> {
    const dbx = await this.client();
    const { result } = await dbx.sharingCreateSharedLinkWithSettings({
      path: this.toDropboxPath(this.resolve(path)),
    });
    return result.url;
  }

  private entryForMetadata(
    metadata: files.FileMetadataReference | files.FolderMetadataReference | files.DeletedMetadataReference | files.MetadataReference,
  ): StorageEntry {
    if (metadata[".tag"] === "folder") {
      const dirPath = this.toUserPath(metadata.path_display ?? `/${metadata.name}`);
      return { path: dirPath, name: metadata.name, type: "directory" };
    }
    return this.entryForFile(metadata as files.FileMetadata);
  }

  private entryForFile(file: files.FileMetadata): StorageEntry {
    const objectPath = this.toUserPath(file.path_display ?? `/${file.name}`);
    const entry: StorageEntry = {
      path: objectPath,
      name: file.name,
      type: "file",
      size: file.size,
    };
    if (file.server_modified) entry.modifiedAt = new Date(file.server_modified);
    if (file.content_hash) entry.etag = file.content_hash;
    return entry;
  }

  /** Map a Dropbox SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const { status, summary } = dropboxError(error);
    if (isPathNotFound(error)) return new NotFoundError(`No object found at "${path}"`);
    if (status === 429 || summary.includes("too_many_requests") || summary.includes("rate_limit")) {
      return new RateLimitError(`Rate limited for "${path}"`, undefined, { cause: error });
    }
    if (status === 503 || status === 502 || status === 504) {
      return new UnavailableError(`Service unavailable for "${path}"`, { cause: error });
    }
    if (status === 409 || summary.includes("conflict")) {
      return new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    if (status === 401 || summary.includes("invalid_access_token")) {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    if (status === 403 || summary.includes("insufficient_scope")) {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`Dropbox operation failed for "${path}"`, "UNKNOWN");
  }
}
