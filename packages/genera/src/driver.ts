import type {
  Capability,
  Environment,
  ListOptions,
  PutData,
  PutOptions,
  SignedUrlOptions,
  StorageEntry,
} from "./types";
import { joinPath, normalizePath } from "./path";

/**
 * The contract every driver implements. The first five methods are the portable
 * core — identical behavior across providers. `native` and `resolveNativeId` are
 * the escape hatch (plan §4): a typed door down to the underlying SDK.
 *
 * `TNative` is the underlying client's type, so `driver.native` stays fully typed.
 */
export interface StorageDriver<TNative = unknown> {
  readonly capabilities: ReadonlySet<Capability>;
  readonly environments: ReadonlySet<Environment>;

  put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry>;
  get(path: string): Promise<Uint8Array>;
  list(prefix?: string, opts?: ListOptions): AsyncIterable<StorageEntry>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;

  /** Escape hatch: the raw underlying SDK client (plan §4.2). */
  readonly native: TNative;
  /** Escape hatch: translate a virtual path to the provider's native id (plan §4.4). */
  resolveNativeId(path: string): Promise<string>;

  // --- Optional, capability-gated operations (plan §2) ---
  // A driver implements only what it advertises in `capabilities`. Callers reach
  // these through `Disk`, which throws `OperationNotSupportedError` when the
  // backing driver doesn't support the capability. The presence of a method here
  // MUST agree with the matching `Capability` flag.

  /** Copy an object (`Capability.Copy`). */
  copy?(from: string, to: string): Promise<StorageEntry>;
  /** Move/rename an object (`Capability.Move`). */
  move?(from: string, to: string): Promise<StorageEntry>;
  /** Rich metadata beyond `exists()` (`Capability.Stat`). */
  stat?(path: string): Promise<StorageEntry>;
  /** A time-limited signed URL (`Capability.SignedUrl`). */
  getSignedUrl?(path: string, opts?: SignedUrlOptions): Promise<string>;
  /** Stream an object's bytes without buffering it all into memory (`Capability.Stream`). */
  getStream?(path: string): Promise<ReadableStream<Uint8Array>>;
  /** Explicitly create a directory (`Capability.CreateDirectory`). */
  createDirectory?(path: string): Promise<void>;
  /** Recursively delete a directory (`Capability.DeleteDirectory`). */
  deleteDirectory?(path: string): Promise<void>;
}

export interface DriverOptions {
  /** Scope every path under this root prefix (multi-tenant safety). */
  root?: string;
}

/**
 * Optional base class. Gives drivers root-scoping and capability helpers for free.
 * Drivers implement the abstract members; everything else is provided.
 */
export abstract class BaseDriver<TNative = unknown> implements StorageDriver<TNative> {
  abstract readonly capabilities: ReadonlySet<Capability>;
  abstract readonly environments: ReadonlySet<Environment>;
  abstract get native(): TNative;

  protected readonly root: string;

  constructor(options: DriverOptions = {}) {
    this.root = options.root ? normalizePath(options.root) : "";
  }

  supports(capability: Capability): boolean {
    return this.capabilities.has(capability);
  }

  runsIn(environment: Environment): boolean {
    return this.environments.has(environment);
  }

  /** Normalize a user path and apply the configured root prefix. */
  protected resolve(path: string): string {
    const normalized = normalizePath(path);
    return this.root ? joinPath(this.root, normalized) : normalized;
  }

  /** Strip the root prefix back off when presenting canonical paths to the user. */
  protected unresolve(key: string): string {
    if (!this.root) return key;
    const prefix = `${this.root}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : key;
  }

  abstract put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry>;
  abstract get(path: string): Promise<Uint8Array>;
  abstract list(prefix?: string, opts?: ListOptions): AsyncIterable<StorageEntry>;
  abstract delete(path: string): Promise<void>;
  abstract exists(path: string): Promise<boolean>;
  abstract resolveNativeId(path: string): Promise<string>;
}
