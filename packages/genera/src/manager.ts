import { DriverMismatchError, OperationNotSupportedError, StorageError } from "./errors";
import { withRetry, type RetryOptions } from "./retry";
import { Capability } from "./types";
import type { StorageEvents } from "./events";
import type {
  Environment,
  ListOptions,
  PutData,
  PutOptions,
  SignedUrlOptions,
  StorageEntry,
} from "./types";
import type { StorageDriver } from "./driver";

type DriverConstructor<T extends StorageDriver> = new (...args: any[]) => T;

export interface DiskOptions {
  /**
   * Retry transient failures (rate limits, unavailability, network blips). `true`
   * uses defaults; pass a `RetryOptions` to tune. Off when omitted (back-compat).
   */
  retry?: RetryOptions | boolean;
  /** Observability hooks fired around each operation. */
  events?: StorageEvents;
}

/**
 * A thin handle over a single driver. Delegates the core operations and exposes
 * the escape hatch (`as`, `unwrap`). Optionally wraps every operation with retry
 * (plan Phase 5) and observability events. Returned by `createStorage` / `manager.disk()`.
 */
export class Disk {
  private readonly retry: RetryOptions | undefined;
  private readonly events: StorageEvents | undefined;

  constructor(
    private readonly driver: StorageDriver,
    options: DiskOptions = {},
  ) {
    this.retry = options.retry === true ? {} : options.retry || undefined;
    this.events = options.events;
  }

  /** Time an operation, optionally retry it, and emit success/error/retry events. */
  private async run<T>(
    operation: string,
    path: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    try {
      const result = this.retry
        ? await withRetry(fn, {
            ...this.retry,
            onRetry: (info) =>
              this.events?.onRetry?.({ operation, path, ...info }),
          })
        : await fn();
      this.events?.onSuccess?.({ operation, path, durationMs: Date.now() - start });
      return result;
    } catch (error) {
      this.events?.onError?.({ operation, path, durationMs: Date.now() - start, error });
      throw error;
    }
  }

  put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    return this.run("put", path, () => this.driver.put(path, data, opts));
  }

  get(path: string): Promise<Uint8Array> {
    return this.run("get", path, () => this.driver.get(path));
  }

  list(prefix?: string, opts?: ListOptions): AsyncIterable<StorageEntry> {
    const inner = this.driver.list(prefix, opts);
    const events = this.events;
    if (!events) return inner;
    return (async function* instrumentedList() {
      const start = Date.now();
      try {
        for await (const entry of inner) yield entry;
        events.onSuccess?.({ operation: "list", path: prefix, durationMs: Date.now() - start });
      } catch (error) {
        events.onError?.({ operation: "list", path: prefix, durationMs: Date.now() - start, error });
        throw error;
      }
    })();
  }

  delete(path: string): Promise<void> {
    return this.run("delete", path, () => this.driver.delete(path));
  }

  exists(path: string): Promise<boolean> {
    return this.run("exists", path, () => this.driver.exists(path));
  }

  get capabilities(): ReadonlySet<Capability> {
    return this.driver.capabilities;
  }

  get environments(): ReadonlySet<Environment> {
    return this.driver.environments;
  }

  // --- Capability-gated operations (plan §2) ---
  // Each guards on the driver's advertised capability and throws a typed
  // `OperationNotSupportedError` otherwise.

  // These are `async` so a missing-capability guard surfaces as a rejected
  // promise (not a synchronous throw), matching the contract callers expect.

  /** Copy an object. Requires `Capability.Copy`. */
  async copy(from: string, to: string): Promise<StorageEntry> {
    this.require(Capability.Copy, "copy");
    return this.run("copy", from, () => this.driver.copy!(from, to));
  }

  /** Move/rename an object. Requires `Capability.Move`. */
  async move(from: string, to: string): Promise<StorageEntry> {
    this.require(Capability.Move, "move");
    return this.run("move", from, () => this.driver.move!(from, to));
  }

  /** Rich metadata beyond `exists()`. Requires `Capability.Stat`. */
  async stat(path: string): Promise<StorageEntry> {
    this.require(Capability.Stat, "stat");
    return this.run("stat", path, () => this.driver.stat!(path));
  }

  /** A time-limited signed URL. Requires `Capability.SignedUrl`. */
  async getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    this.require(Capability.SignedUrl, "getSignedUrl");
    return this.run("getSignedUrl", path, () => this.driver.getSignedUrl!(path, opts));
  }

  /** Explicitly create a directory. Requires `Capability.CreateDirectory`. */
  async createDirectory(path: string): Promise<void> {
    this.require(Capability.CreateDirectory, "createDirectory");
    return this.run("createDirectory", path, () => this.driver.createDirectory!(path));
  }

  /** Recursively delete a directory. Requires `Capability.DeleteDirectory`. */
  async deleteDirectory(path: string): Promise<void> {
    this.require(Capability.DeleteDirectory, "deleteDirectory");
    return this.run("deleteDirectory", path, () => this.driver.deleteDirectory!(path));
  }

  /**
   * Guard a capability-gated call: the driver must both advertise the capability
   * and actually implement the method. Otherwise throw `OperationNotSupportedError`.
   */
  private require(capability: Capability, method: string): void {
    const impl = (this.driver as unknown as Record<string, unknown>)[method];
    if (!this.driver.capabilities.has(capability) || typeof impl !== "function") {
      throw new OperationNotSupportedError(
        `Driver does not support the "${capability}" capability`,
        capability,
      );
    }
  }

  /**
   * Escape hatch (plan §4.3): narrow to a concrete driver to call its
   * provider-specific methods. Throws `DriverMismatchError` if the disk is not
   * backed by that driver.
   */
  as<T extends StorageDriver>(DriverClass: DriverConstructor<T>): T {
    if (this.driver instanceof DriverClass) {
      return this.driver as T;
    }
    throw new DriverMismatchError(
      `Disk driver is not an instance of ${DriverClass.name}`,
    );
  }

  /** Escape hatch: the underlying driver instance. */
  unwrap(): StorageDriver {
    return this.driver;
  }
}

/** Wrap a single driver into a ready-to-use `Disk`. */
export function createStorage(driver: StorageDriver, options?: DiskOptions): Disk {
  return new Disk(driver, options);
}

export interface ManagerConfig {
  /** Name of the disk returned by `disk()` with no arguments. */
  default: string;
  disks: Record<string, StorageDriver>;
  /** Options applied to every disk (retry, events). */
  options?: DiskOptions;
}

/** Holds several named disks; `disk(name)` selects one. */
export class StorageManager {
  private readonly disks: Map<string, Disk>;
  private readonly defaultDisk: string;

  constructor(config: ManagerConfig) {
    this.defaultDisk = config.default;
    this.disks = new Map(
      Object.entries(config.disks).map(([name, driver]) => [
        name,
        new Disk(driver, config.options),
      ]),
    );
  }

  disk(name: string = this.defaultDisk): Disk {
    const disk = this.disks.get(name);
    if (!disk) {
      throw new StorageError(`Unknown disk: "${name}"`, "UNKNOWN");
    }
    return disk;
  }
}

export function createManager(config: ManagerConfig): StorageManager {
  return new StorageManager(config);
}
