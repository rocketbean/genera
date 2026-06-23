import { Readable } from "node:stream";

import { drive as makeDrive, type drive_v3 } from "@googleapis/drive";

import {
  AlreadyExistsError,
  AuthError,
  BaseDriver,
  Capability,
  NotFoundError,
  PathResolver,
  PermissionError,
  RateLimitError,
  StorageError,
  UnavailableError,
  basename,
  parentPath,
  toBytes,
  type CredentialProvider,
  type DriverOptions,
  type Environment,
  type ListOptions,
  type OAuthCredential,
  type PathResolverAdapter,
  type PutData,
  type PutOptions,
  type StorageEntry,
} from "@rocketbean/genera";

const FOLDER_MIME = "application/vnd.google-apps.folder";

/** Escape a value for a Drive `q` query string literal. */
function driveQuote(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/** A minimal shape for an auth client whose token the driver refreshes. */
interface RefreshableAuth {
  setCredentials?(tokens: { access_token?: string }): void;
}

export interface GoogleDriveDriverOptions extends DriverOptions {
  /** Escape hatch (and test seam): a fully-configured `drive_v3.Drive` client. */
  drive?: drive_v3.Drive;
  /** A googleapis auth client (e.g. `OAuth2Client`) the driver builds the client from. */
  auth?: RefreshableAuth;
  /** OAuth provider; its access token is pushed onto `auth` before each request. */
  credentials?: CredentialProvider<OAuthCredential>;
  /** Shared (Team) drive id. When set, all calls include the all-drives params. */
  driveId?: string;
  /** Scope every path under this folder id instead of "root". */
  rootFolderId?: string;
  /** Same-name-sibling policy (Drive allows duplicates). Default "first". */
  onAmbiguous?: "first" | "error";
}

function statusOf(error: unknown): number | undefined {
  const e = error as { code?: number; response?: { status?: number } } | undefined;
  return e?.code ?? e?.response?.status;
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

/**
 * Google Drive driver — the **ID-native** case. Files are opaque ids and paths
 * must be resolved by walking the tree, so this is the primary consumer of the
 * `PathResolver` (cache + resolve-or-create + ambiguity policy, plan §3.4).
 * **Node-only** (the SDK is). Auth is an `OAuthCredentialProvider` pushed onto a
 * googleapis auth client before each request.
 */
export class GoogleDriveDriver extends BaseDriver<drive_v3.Drive> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
    Capability.CreateDirectory,
    Capability.DeleteDirectory,
    Capability.Stream,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>(["node"]);

  private readonly api: drive_v3.Drive;
  private readonly options: GoogleDriveDriverOptions;
  private readonly resolver: PathResolver;

  constructor(options: GoogleDriveDriverOptions) {
    super(options);
    if (!options.drive && !options.auth) {
      throw new StorageError("GoogleDriveDriver needs one of: drive or auth", "AUTH");
    }
    this.options = options;
    this.api = options.drive ?? makeDrive({ version: "v3", auth: options.auth as never });

    const adapter: PathResolverAdapter = {
      rootId: options.rootFolderId ?? options.driveId ?? "root",
      listChildren: (parentId, name) => this.listChildren(parentId, name),
      createFolder: (parentId, name) => this.createFolder(parentId, name),
    };
    this.resolver = new PathResolver(adapter, { onAmbiguous: options.onAmbiguous ?? "first" });
  }

  get native(): drive_v3.Drive {
    return this.api;
  }

  /** Push the latest access token onto the auth client (when using the OAuth provider). */
  private async ready(): Promise<drive_v3.Drive> {
    if (!this.options.drive && this.options.credentials && this.options.auth?.setCredentials) {
      const { accessToken } = await this.options.credentials.getCredential();
      this.options.auth.setCredentials({ access_token: accessToken });
    }
    return this.api;
  }

  private listParams(): Record<string, unknown> {
    return this.options.driveId
      ? {
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          corpora: "drive",
          driveId: this.options.driveId,
        }
      : { supportsAllDrives: true, includeItemsFromAllDrives: true };
  }

  private async listChildren(
    parentId: string,
    name: string,
  ): Promise<{ id: string; type: "file" | "directory" }[]> {
    const api = await this.ready();
    const res = await api.files.list({
      q: `${driveQuote(parentId)} in parents and name = ${driveQuote(name)} and trashed = false`,
      fields: "files(id, name, mimeType)",
      pageSize: 10,
      ...this.listParams(),
    });
    return (res.data.files ?? []).map((file) => ({
      id: file.id!,
      type: file.mimeType === FOLDER_MIME ? ("directory" as const) : ("file" as const),
    }));
  }

  private async createFolder(parentId: string, name: string): Promise<string> {
    const api = await this.ready();
    const res = await api.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId] },
      fields: "id",
      supportsAllDrives: true,
    });
    return res.data.id!;
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    const existing = await this.resolver.resolve(key);
    if (existing && opts?.overwrite === false) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const bytes = await toBytes(data);
    const media = {
      mimeType: opts?.contentType ?? "application/octet-stream",
      body: Readable.from(Buffer.from(bytes)),
    };
    const api = await this.ready();
    let id: string;
    try {
      if (existing && existing.type === "file") {
        const res = await api.files.update({ fileId: existing.id, media, fields: "id", supportsAllDrives: true });
        id = res.data.id ?? existing.id;
      } else {
        const parentId = await this.resolver.resolveDirectoryCreating(parentPath(key));
        const res = await api.files.create({
          requestBody: { name: basename(key), parents: [parentId] },
          media,
          fields: "id",
          supportsAllDrives: true,
        });
        id = res.data.id!;
      }
    } catch (error) {
      throw this.mapError(error, path);
    }
    this.resolver.prime(key, { id, type: "file" });
    return {
      path: this.unresolve(key),
      name: basename(key),
      type: "file",
      size: bytes.byteLength,
      modifiedAt: new Date(),
    };
  }

  async get(path: string): Promise<Uint8Array> {
    const node = await this.resolver.resolve(this.resolve(path));
    if (!node || node.type !== "file") {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    const api = await this.ready();
    try {
      const res = await api.files.get(
        { fileId: node.id, alt: "media", supportsAllDrives: true },
        { responseType: "arraybuffer" },
      );
      return new Uint8Array(res.data as unknown as ArrayBuffer);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const folder = await this.resolver.resolve(scope);
    if (!folder || folder.type !== "directory") return;
    const state: { count: number; limit: number | undefined } = { count: 0, limit: opts?.limit };
    yield* this.walk(folder.id, scope, recursive, state);
  }

  private async *walk(
    folderId: string,
    scopeKey: string,
    recursive: boolean,
    state: { count: number; limit: number | undefined },
  ): AsyncIterable<StorageEntry> {
    let pageToken: string | undefined;
    do {
      const api = await this.ready();
      const res = await api.files.list({
        q: `${driveQuote(folderId)} in parents and trashed = false`,
        fields: "nextPageToken, files(id, name, mimeType, size, modifiedTime, md5Checksum)",
        pageSize: 1000,
        ...(pageToken ? { pageToken } : {}),
        ...this.listParams(),
      });
      for (const file of res.data.files ?? []) {
        const name = file.name ?? "";
        const childKey = scopeKey ? `${scopeKey}/${name}` : name;
        if (file.mimeType === FOLDER_MIME) {
          if (recursive) {
            yield* this.walk(file.id!, childKey, true, state);
          } else {
            if (state.limit !== undefined && state.count >= state.limit) return;
            yield { path: this.unresolve(childKey), name, type: "directory" };
            state.count++;
          }
        } else {
          if (state.limit !== undefined && state.count >= state.limit) return;
          yield this.entryForFile(file, childKey);
          state.count++;
        }
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }

  async delete(path: string): Promise<void> {
    const key = this.resolve(path);
    const node = await this.resolver.resolve(key);
    if (!node) return; // idempotent: unresolved is a no-op
    const api = await this.ready();
    try {
      await api.files.delete({ fileId: node.id, supportsAllDrives: true });
    } catch (error) {
      if (!isNotFound(error)) throw this.mapError(error, path);
    }
    this.resolver.invalidate(key);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.resolver.resolve(this.resolve(path))) !== undefined;
  }

  async resolveNativeId(path: string): Promise<string> {
    const node = await this.resolver.resolve(this.resolve(path));
    if (!node) throw new NotFoundError(`No object found at "${path}"`);
    return node.id;
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  // Portable copy: download + re-upload. (Drive's server-side files.copy is a Phase 5 opt.)
  async copy(from: string, to: string): Promise<StorageEntry> {
    return this.put(to, await this.get(from));
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const entry = await this.copy(from, to);
    await this.delete(from);
    return entry;
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    const node = await this.resolver.resolve(key);
    if (!node) throw new NotFoundError(`No object found at "${path}"`);
    if (node.type === "directory") {
      return { path: this.unresolve(key), name: basename(key), type: "directory" };
    }
    const api = await this.ready();
    const res = await api.files.get({
      fileId: node.id,
      fields: "id, name, size, modifiedTime, md5Checksum",
      supportsAllDrives: true,
    });
    return this.entryForFile(res.data, key);
  }

  async createDirectory(path: string): Promise<void> {
    await this.resolver.resolveDirectoryCreating(this.resolve(path));
  }

  async deleteDirectory(path: string): Promise<void> {
    await this.delete(path);
  }

  // --- Layer-1, Drive-specific escape hatch (plan §4.1) ---

  /**
   * Export a native Google Doc/Sheet/Slide to bytes of `mimeType`. Required for
   * Google-native files, which cannot be downloaded via `alt=media`.
   */
  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const node = await this.resolver.resolve(this.resolve(path));
    if (!node || node.type !== "file") {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    const api = await this.ready();
    try {
      const res = await api.files.get(
        { fileId: node.id, alt: "media", supportsAllDrives: true },
        { responseType: "stream" },
      );
      return Readable.toWeb(res.data as unknown as Readable) as ReadableStream<Uint8Array>;
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async export(path: string, mimeType: string): Promise<Uint8Array> {
    const node = await this.resolver.resolve(this.resolve(path));
    if (!node) throw new NotFoundError(`No object found at "${path}"`);
    const api = await this.ready();
    const res = await api.files.export(
      { fileId: node.id, mimeType },
      { responseType: "arraybuffer" },
    );
    return new Uint8Array(res.data as unknown as ArrayBuffer);
  }

  private entryForFile(file: drive_v3.Schema$File, key: string): StorageEntry {
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: file.name ?? basename(objectPath),
      type: "file",
      size: Number(file.size ?? 0),
    };
    if (file.modifiedTime) entry.modifiedAt = new Date(file.modifiedTime);
    if (file.md5Checksum) entry.etag = file.md5Checksum;
    return entry;
  }

  /** Map a googleapis error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const status = statusOf(error);
    if (status === 404) return new NotFoundError(`No object found at "${path}"`);
    if (status === 429) {
      return new RateLimitError(`Rate limited for "${path}"`, undefined, { cause: error });
    }
    if (status === 502 || status === 503 || status === 504) {
      return new UnavailableError(`Service unavailable for "${path}"`, { cause: error });
    }
    if (status === 403) {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    if (status === 401) {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`Google Drive operation failed for "${path}"`, "UNKNOWN");
  }
}
