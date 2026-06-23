import { Client, ResponseType } from "@microsoft/microsoft-graph-client";
import type { DriveItem } from "@microsoft/microsoft-graph-types";

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
  parentPath,
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

export interface OneDriveDriverOptions extends DriverOptions {
  /** OAuth credential provider — bridged into the Graph auth provider. */
  credentials?: CredentialProvider<OAuthCredential>;
  /** A static access token (alternative to `credentials`). */
  accessToken?: string;
  /** Escape hatch (and test seam): bring your own configured Graph `Client`. */
  client?: Client;
}

function statusOf(error: unknown): number | undefined {
  return (error as { statusCode?: number } | undefined)?.statusCode;
}

function isNotFound(error: unknown): boolean {
  return statusOf(error) === 404;
}

/** Wrap a Node `Readable` (the Graph stream download body) as a web `ReadableStream`. */
function nodeReadableToWeb(readable: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
  const iterator = (readable as AsyncIterable<Buffer | Uint8Array | string>)[
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

/**
 * OneDrive driver over Microsoft Graph — a **path-native** Tier 2 provider: Graph
 * addresses items by path (`/me/drive/root:/a/b.txt:`), so the only translation is
 * that syntax. Isomorphic; downloads use `ResponseType.ARRAYBUFFER` (works in both
 * runtimes). Auth is an `OAuthCredentialProvider` bridged into the Graph
 * `authProvider.getAccessToken` — refresh/skew/race all live in the provider.
 */
export class OneDriveDriver extends BaseDriver<Client> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.SignedUrl,
    Capability.Stream,
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

  private readonly graph: Client;

  constructor(options: OneDriveDriverOptions) {
    super(options);
    if (!options.client && !options.accessToken && !options.credentials) {
      throw new StorageError(
        "OneDriveDriver needs one of: credentials, accessToken, or client",
        "AUTH",
      );
    }
    this.graph =
      options.client ??
      Client.initWithMiddleware({
        authProvider: {
          // The Graph client calls this per request; delegate to the OAuth provider.
          getAccessToken: async () =>
            options.accessToken ?? (await options.credentials!.getCredential()).accessToken,
        },
      });
  }

  get native(): Client {
    return this.graph;
  }

  /** Canonical (root-scoped) key -> Graph item address. */
  private toItemPath(key: string): string {
    return key === "" ? "/me/drive/root" : `/me/drive/root:/${key}:`;
  }

  private toChildrenPath(key: string): string {
    return key === "" ? "/me/drive/root/children" : `/me/drive/root:/${key}:/children`;
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false && (await this.exists(path))) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    try {
      const item: DriveItem = await this.graph
        .api(`${this.toItemPath(key)}/content`)
        .put(await toBytes(data));
      return this.entryForItem(item, key);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async get(path: string): Promise<Uint8Array> {
    const key = this.resolve(path);
    try {
      const buffer: ArrayBuffer = await this.graph
        .api(`${this.toItemPath(key)}/content`)
        .responseType(ResponseType.ARRAYBUFFER)
        .get();
      return new Uint8Array(buffer);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const state: { count: number; limit: number | undefined } = {
      count: 0,
      limit: opts?.limit,
    };
    try {
      yield* this.walk(scope, recursive, state);
    } catch (error) {
      if (isNotFound(error)) return; // listing a missing prefix yields nothing
      throw this.mapError(error, prefix);
    }
  }

  // Graph has no recursive listing, so the driver walks children level by level.
  private async *walk(
    scopeKey: string,
    recursive: boolean,
    state: { count: number; limit: number | undefined },
  ): AsyncIterable<StorageEntry> {
    let page = await this.graph.api(this.toChildrenPath(scopeKey)).get();
    for (;;) {
      for (const item of (page.value ?? []) as DriveItem[]) {
        const name = item.name ?? "";
        const childKey = scopeKey ? `${scopeKey}/${name}` : name;
        if (item.folder) {
          if (recursive) {
            yield* this.walk(childKey, true, state);
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
      const next = page["@odata.nextLink"] as string | undefined;
      if (!next) break;
      page = await this.graph.api(next).get();
    }
  }

  async delete(path: string): Promise<void> {
    try {
      await this.graph.api(this.toItemPath(this.resolve(path))).delete();
    } catch (error) {
      if (!isNotFound(error)) throw this.mapError(error, path); // idempotent
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.graph.api(this.toItemPath(this.resolve(path))).get();
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw this.mapError(error, path);
    }
  }

  async resolveNativeId(path: string): Promise<string> {
    const key = this.resolve(path);
    try {
      const item: DriveItem = await this.graph.api(this.toItemPath(key)).get();
      return item.id ?? key;
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  // Portable copy: download + re-upload. (Graph's server-side /copy is async with a
  // monitor URL — a Phase 5 optimization.)
  async copy(from: string, to: string): Promise<StorageEntry> {
    const bytes = await this.get(from);
    return this.put(to, bytes);
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const entry = await this.copy(from, to);
    await this.delete(from);
    return entry;
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    try {
      const item: DriveItem = await this.graph.api(this.toItemPath(key)).get();
      return this.entryForItem(item, key);
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async createDirectory(path: string): Promise<void> {
    const key = this.resolve(path);
    const parent = parentPath(key);
    try {
      await this.graph.api(this.toChildrenPath(parent)).post({
        name: basename(key),
        folder: {},
        "@microsoft.graph.conflictBehavior": "replace",
      });
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  async deleteDirectory(path: string): Promise<void> {
    try {
      await this.graph.api(this.toItemPath(this.resolve(path))).delete();
    } catch (error) {
      if (!isNotFound(error)) throw this.mapError(error, path);
    }
  }

  /**
   * A OneDrive sharing link via `createLink`. Note the semantic difference: this is
   * a sharing link, **not** a time-limited presigned URL (`expiresIn` is ignored).
   */
  async getSignedUrl(path: string, _opts?: SignedUrlOptions): Promise<string> {
    const key = this.resolve(path);
    const result = await this.graph.api(`${this.toItemPath(key)}/createLink`).post({
      type: "view",
      scope: "anonymous",
    });
    return result.link?.webUrl ?? "";
  }

  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const key = this.resolve(path);
    try {
      if (typeof window === "undefined") {
        const readable = await this.graph
          .api(`${this.toItemPath(key)}/content`)
          .responseType(ResponseType.STREAM)
          .get();
        return nodeReadableToWeb(readable as NodeJS.ReadableStream);
      }
      // Browser: Graph's stream type isn't a web stream — fall back to a one-shot wrap.
      const bytes = await this.get(path);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      });
    } catch (error) {
      throw this.mapError(error, path);
    }
  }

  private entryForItem(item: DriveItem, key: string): StorageEntry {
    const objectPath = this.unresolve(key);
    if (item.folder) {
      return { path: objectPath, name: item.name ?? basename(objectPath), type: "directory" };
    }
    const entry: StorageEntry = {
      path: objectPath,
      name: item.name ?? basename(objectPath),
      type: "file",
      size: item.size ?? 0,
    };
    if (item.lastModifiedDateTime) entry.modifiedAt = new Date(item.lastModifiedDateTime);
    if (item.eTag) entry.etag = item.eTag;
    return entry;
  }

  /** Map a Graph SDK error onto the Genera error taxonomy. */
  private mapError(error: unknown, path: string): Error {
    if (error instanceof StorageError) return error;
    const status = statusOf(error);
    const code = (error as { code?: string } | undefined)?.code;
    if (status === 404) return new NotFoundError(`No object found at "${path}"`);
    if (status === 429) {
      return new RateLimitError(`Rate limited for "${path}"`, undefined, { cause: error });
    }
    if (status === 502 || status === 503 || status === 504) {
      return new UnavailableError(`Service unavailable for "${path}"`, { cause: error });
    }
    if (status === 409) return new AlreadyExistsError(`Object already exists at "${path}"`);
    if (status === 403) {
      return new PermissionError(`Permission denied for "${path}"`, { cause: error });
    }
    if (status === 401 || code === "InvalidAuthenticationToken") {
      return new AuthError(`Authentication failed for "${path}"`, { cause: error });
    }
    return error instanceof Error
      ? error
      : new StorageError(`OneDrive operation failed for "${path}"`, "UNKNOWN");
  }
}
