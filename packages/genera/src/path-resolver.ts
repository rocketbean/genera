import { InvalidPathError } from "./errors";
import { normalizePath } from "./path";

/**
 * A resolved node in an ID-native provider (Google Drive, Box): the provider's
 * stable identifier plus whether it is a file or a directory.
 */
export interface ResolverNode {
  id: string;
  type: "file" | "directory";
}

/**
 * The provider-specific seam the resolver drives. Drivers implement these three
 * members; the path-walking, caching, and ambiguity policy live in `PathResolver`.
 */
export interface PathResolverAdapter {
  /** The id of the root container (Drive `"root"`, Box `"0"`, …). */
  readonly rootId: string;
  /**
   * Every direct child of `parentId` whose name is exactly `name`. Returning all
   * matches (not just one) lets the resolver apply the same-name-sibling policy.
   */
  listChildren(parentId: string, name: string): Promise<ResolverNode[]>;
  /** Create a folder named `name` under `parentId`; return its id. */
  createFolder(parentId: string, name: string): Promise<string>;
}

export interface PathResolverOptions {
  /**
   * Policy for same-name siblings (drives allow them; key-native stores don't).
   * "first" (default) takes the first match deterministically; "error" throws.
   */
  onAmbiguous?: "first" | "error";
}

/**
 * Translates canonical Genera paths to provider node ids for ID-native drivers,
 * with a path→node cache, resolve-or-create-folder, and a same-name-sibling
 * policy (plan §3.4). Isomorphic — pure string/Map logic over an async adapter.
 */
export class PathResolver {
  private readonly cache = new Map<string, ResolverNode>();
  private readonly onAmbiguous: "first" | "error";
  private readonly rootNode: ResolverNode;

  constructor(
    private readonly adapter: PathResolverAdapter,
    options: PathResolverOptions = {},
  ) {
    this.onAmbiguous = options.onAmbiguous ?? "first";
    this.rootNode = { id: adapter.rootId, type: "directory" };
  }

  /** Resolve a canonical path to a node, or `undefined` if any segment is missing. */
  async resolve(path: string): Promise<ResolverNode | undefined> {
    const key = normalizePath(path);
    if (key === "") return this.rootNode;

    const segments = key.split("/");
    let parent = this.rootNode;
    let prefix = "";
    for (let i = 0; i < segments.length; i++) {
      prefix = prefix ? `${prefix}/${segments[i]}` : segments[i]!;
      let node = this.cache.get(prefix);
      if (!node) {
        if (parent.type !== "directory") return undefined;
        node = this.pick(await this.adapter.listChildren(parent.id, segments[i]!), prefix);
        if (!node) return undefined;
        this.cache.set(prefix, node);
      }
      if (i < segments.length - 1 && node.type !== "directory") return undefined;
      parent = node;
    }
    return parent;
  }

  /**
   * Ensure the directory chain for `path` exists, creating missing folders, and
   * return the final directory's id. The empty path resolves to the root.
   */
  async resolveDirectoryCreating(path: string): Promise<string> {
    const key = normalizePath(path);
    if (key === "") return this.rootNode.id;

    let parent = this.rootNode;
    let prefix = "";
    for (const name of key.split("/")) {
      prefix = prefix ? `${prefix}/${name}` : name;
      let node = this.cache.get(prefix);
      if (!node) {
        node = this.pick(await this.adapter.listChildren(parent.id, name), prefix);
      }
      if (node?.type === "file") {
        throw new InvalidPathError(`Path segment "${prefix}" is a file, not a directory`);
      }
      if (!node) {
        node = { id: await this.adapter.createFolder(parent.id, name), type: "directory" };
      }
      this.cache.set(prefix, node);
      parent = node;
    }
    return parent.id;
  }

  /** Seed the cache (e.g. after a driver creates a file), so later lookups skip the round-trip. */
  prime(path: string, node: ResolverNode): void {
    this.cache.set(normalizePath(path), node);
  }

  /** Drop `path` and everything beneath it from the cache (call on delete/move). */
  invalidate(path: string): void {
    const key = normalizePath(path);
    this.cache.delete(key);
    const prefix = `${key}/`;
    for (const cached of this.cache.keys()) {
      if (cached.startsWith(prefix)) this.cache.delete(cached);
    }
  }

  /** Drop the entire cache. */
  clear(): void {
    this.cache.clear();
  }

  private pick(matches: ResolverNode[], prefix: string): ResolverNode | undefined {
    if (matches.length === 0) return undefined;
    if (matches.length > 1 && this.onAmbiguous === "error") {
      throw new InvalidPathError(
        `Ambiguous path "${prefix}": ${matches.length} entries share this name`,
      );
    }
    return matches[0];
  }
}
