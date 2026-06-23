import { Readable } from "node:stream";

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
  type DriverOptions,
  type Environment,
  type ListOptions,
  type PathResolverAdapter,
  type PutData,
  type PutOptions,
  type StorageEntry,
} from "@rocketbean/genera";

/**
 * A structural view of the Box SDK client. The generated `box-node-sdk` shifts
 * method names/shapes between minor versions, so the driver depends on this
 * structural surface (which the real `BoxClient` satisfies) rather than importing
 * concrete types — keeping the driver compilable across SDK versions. `native`
 * returns whatever client you pass in.
 */
export interface BoxItem {
  id: string;
  type: "file" | "folder";
  name?: string;
  size?: number;
  modified_at?: string;
  etag?: string;
}

export interface BoxClient {
  folders: {
    getFolderItems(
      folderId: string,
      options?: unknown,
    ): Promise<{ entries?: BoxItem[]; nextMarker?: string }>;
    createFolder(
      body: { name: string; parent: { id: string } },
      options?: unknown,
    ): Promise<BoxItem>;
    deleteFolderById(folderId: string, options?: unknown): Promise<unknown>;
  };
  files: {
    getFileById(fileId: string, options?: unknown): Promise<BoxItem>;
    deleteFileById(fileId: string, options?: unknown): Promise<unknown>;
  };
  uploads: {
    uploadFile(
      body: { attributes: { name: string; parent: { id: string } }; file: unknown },
      options?: unknown,
    ): Promise<{ entries?: BoxItem[] }>;
    uploadFileVersion(
      fileId: string,
      body: { file: unknown },
      options?: unknown,
    ): Promise<{ entries?: BoxItem[] }>;
  };
  downloads: {
    downloadFile(fileId: string, options?: unknown): Promise<unknown>;
  };
}

export interface BoxDriverOptions extends DriverOptions {
  /** A configured Box client. The app builds it with its chosen Box auth mode. */
  client: BoxClient;
  /** Root folder id. Box's account root is `"0"` (the default). */
  rootFolderId?: string;
  /** Same-name-sibling policy. Box usually disallows duplicates; default "first". */
  onAmbiguous?: "first" | "error";
}

function statusOf(error: unknown): number | undefined {
  const e = error as { statusCode?: number; response?: { status?: number } } | undefined;
  return e?.statusCode ?? e?.response?.status;
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

/** Return a Box download as a web `ReadableStream` (it may arrive as a Node `Readable`). */
function toWebStream(stream: unknown): ReadableStream<Uint8Array> {
  if (stream instanceof ReadableStream) return stream as ReadableStream<Uint8Array>;
  const iterator = (stream as AsyncIterable<Buffer | Uint8Array | string>)[
    Symbol.asyncIterator
  ]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(
        typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value),
      );
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

/** Drain a Box download (Node `Readable`, web `ReadableStream`, or raw bytes) into a `Uint8Array`. */
async function streamToBytes(stream: unknown): Promise<Uint8Array> {
  if (stream instanceof Uint8Array) return new Uint8Array(stream);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const push = (chunk: Buffer | Uint8Array | string): void => {
    const part = typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    chunks.push(part);
    total += part.byteLength;
  };
  if (typeof (stream as ReadableStream).getReader === "function") {
    const reader = (stream as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) push(value);
    }
  } else {
    for await (const chunk of stream as AsyncIterable<Buffer | Uint8Array | string>) push(chunk);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/**
 * Box driver — the second **ID-native** provider (root folder id `"0"`). Items are
 * opaque ids and paths are resolved by walking the tree, so it shares the
 * `PathResolver` (cache + resolve-or-create, plan §3.4). Node runtime (uploads use
 * a Node stream). The app supplies a configured `BoxClient`.
 */
export class BoxDriver extends BaseDriver<BoxClient> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
    Capability.CreateDirectory,
    Capability.DeleteDirectory,
    Capability.Stream,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>(["node"]);

  private readonly client: BoxClient;
  private readonly resolver: PathResolver;

  constructor(options: BoxDriverOptions) {
    super(options);
    this.client = options.client;
    const adapter: PathResolverAdapter = {
      rootId: options.rootFolderId ?? "0",
      listChildren: (parentId, name) => this.listChildren(parentId, name),
      createFolder: async (parentId, name) =>
        (await this.client.folders.createFolder({ name, parent: { id: parentId } })).id,
    };
    this.resolver = new PathResolver(adapter, { onAmbiguous: options.onAmbiguous ?? "first" });
  }

  get native(): BoxClient {
    return this.client;
  }

  private async listChildren(
    parentId: string,
    name: string,
  ): Promise<{ id: string; type: "file" | "directory" }[]> {
    const page = await this.client.folders.getFolderItems(parentId, {
      queryParams: { fields: ["id", "name", "type"], limit: 1000 },
    });
    return (page.entries ?? [])
      .filter((item) => item.name === name)
      .map((item) => ({
        id: item.id,
        type: item.type === "folder" ? ("directory" as const) : ("file" as const),
      }));
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    const existing = await this.resolver.resolve(key);
    if (existing && opts?.overwrite === false) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const bytes = await toBytes(data);
    const file = Readable.from(Buffer.from(bytes));
    let id: string | undefined;
    try {
      if (existing && existing.type === "file") {
        const res = await this.client.uploads.uploadFileVersion(existing.id, { file });
        id = res.entries?.[0]?.id ?? existing.id;
      } else {
        const parentId = await this.resolver.resolveDirectoryCreating(parentPath(key));
        const res = await this.client.uploads.uploadFile({
          attributes: { name: basename(key), parent: { id: parentId } },
          file,
        });
        id = res.entries?.[0]?.id;
      }
    } catch (error) {
      throw this.mapError(error, path);
    }
    if (!id) throw new StorageError(`Box upload for "${path}" returned no id`, "UNKNOWN");
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
    try {
      return await streamToBytes(await this.client.downloads.downloadFile(node.id));
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
    let marker: string | undefined;
    do {
      const page = await this.client.folders.getFolderItems(folderId, {
        queryParams: {
          usemarker: true,
          marker,
          limit: 1000,
          fields: ["id", "name", "type", "size", "modified_at", "etag"],
        },
      });
      for (const item of page.entries ?? []) {
        const name = item.name ?? "";
        const childKey = scopeKey ? `${scopeKey}/${name}` : name;
        if (item.type === "folder") {
          if (recursive) {
            yield* this.walk(item.id, childKey, true, state);
          } else {
            if (state.limit !== undefined && state.count >= state.limit) return;
            yield { path: this.unresolve(childKey), name, type: "directory" };
            state.count++;
          }
        } else {
          if (state.limit !== undefined && state.count >= state.limit) return;
          yield this.entryForItem(item, childKey);
          state.count++;
        }
      }
      marker = page.nextMarker;
    } while (marker);
  }

  async delete(path: string): Promise<void> {
    const key = this.resolve(path);
    const node = await this.resolver.resolve(key);
    if (!node) return; // idempotent
    try {
      if (node.type === "directory") {
        await this.client.folders.deleteFolderById(node.id, { queryParams: { recursive: true } });
      } else {
        await this.client.files.deleteFileById(node.id);
      }
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

  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const node = await this.resolver.resolve(this.resolve(path));
    if (!node || node.type !== "file") {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    try {
      return toWebStream(await this.client.downloads.downloadFile(node.id));
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  // Portable copy: download + re-upload. (Box's server-side copyFile is a Phase 5 opt.)
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
    const item = await this.client.files.getFileById(node.id, {
      queryParams: { fields: ["id", "name", "size", "modified_at", "etag"] },
    });
    return this.entryForItem(item, key);
  }

  async createDirectory(path: string): Promise<void> {
    await this.resolver.resolveDirectoryCreating(this.resolve(path));
  }

  async deleteDirectory(path: string): Promise<void> {
    await this.delete(path);
  }

  private entryForItem(item: BoxItem, key: string): StorageEntry {
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: item.name ?? basename(objectPath),
      type: "file",
      size: Number(item.size ?? 0),
    };
    if (item.modified_at) entry.modifiedAt = new Date(item.modified_at);
    if (item.etag) entry.etag = item.etag;
    return entry;
  }

  /** Map a Box SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const status = statusOf(error);
    if (status === 404) return new NotFoundError(`No object found at "${path}"`);
    if (status === 409) return new AlreadyExistsError(`Object already exists at "${path}"`);
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
      : new StorageError(`Box operation failed for "${path}"`, "UNKNOWN");
  }
}
