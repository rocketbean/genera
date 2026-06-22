import { DriverMismatchError, OperationNotSupportedError, StorageError } from "./errors";
import { Capability } from "./types";
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

/**
 * A thin handle over a single driver. Delegates the core operations and exposes
 * the escape hatch (`as`, `unwrap`). Returned by `createStorage` and `manager.disk()`.
 */
export class Disk {
  constructor(private readonly driver: StorageDriver) {}

  put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    return this.driver.put(path, data, opts);
  }

  get(path: string): Promise<Uint8Array> {
    return this.driver.get(path);
  }

  list(prefix?: string, opts?: ListOptions): AsyncIterable<StorageEntry> {
    return this.driver.list(prefix, opts);
  }

  delete(path: string): Promise<void> {
    return this.driver.delete(path);
  }

  exists(path: string): Promise<boolean> {
    return this.driver.exists(path);
  }

  get capabilities(): ReadonlySet<Capability> {
    return this.driver.capabilities;
  }

  get environments(): ReadonlySet<Environment> {
    return this.driver.environments;
  }

  // --- Capability-gated operations (plan §2) ---
  // Each guards on the driver's advertised capability and throws a typed
  // `OperationNotSupportedError` otherwise. The methods are async so an
  // unsupported call surfaces as a rejected promise, not a synchronous throw.

  /** Copy an object. Requires `Capability.Copy`. */
  async copy(from: string, to: string): Promise<StorageEntry> {
    this.require(Capability.Copy, "copy");
    return this.driver.copy!(from, to);
  }

  /** Move/rename an object. Requires `Capability.Move`. */
  async move(from: string, to: string): Promise<StorageEntry> {
    this.require(Capability.Move, "move");
    return this.driver.move!(from, to);
  }

  /** Rich metadata beyond `exists()`. Requires `Capability.Stat`. */
  async stat(path: string): Promise<StorageEntry> {
    this.require(Capability.Stat, "stat");
    return this.driver.stat!(path);
  }

  /** A time-limited signed URL. Requires `Capability.SignedUrl`. */
  async getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    this.require(Capability.SignedUrl, "getSignedUrl");
    return this.driver.getSignedUrl!(path, opts);
  }

  /** Explicitly create a directory. Requires `Capability.CreateDirectory`. */
  async createDirectory(path: string): Promise<void> {
    this.require(Capability.CreateDirectory, "createDirectory");
    return this.driver.createDirectory!(path);
  }

  /** Recursively delete a directory. Requires `Capability.DeleteDirectory`. */
  async deleteDirectory(path: string): Promise<void> {
    this.require(Capability.DeleteDirectory, "deleteDirectory");
    return this.driver.deleteDirectory!(path);
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
   * backed by that driver. The explicit narrowing is the "leaving portable land" signal.
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
export function createStorage(driver: StorageDriver): Disk {
  return new Disk(driver);
}

export interface ManagerConfig {
  /** Name of the disk returned by `disk()` with no arguments. */
  default: string;
  disks: Record<string, StorageDriver>;
}

/** Holds several named disks; `disk(name)` selects one. */
export class StorageManager {
  private readonly disks: Map<string, Disk>;
  private readonly defaultDisk: string;

  constructor(config: ManagerConfig) {
    this.defaultDisk = config.default;
    this.disks = new Map(
      Object.entries(config.disks).map(([name, driver]) => [name, new Disk(driver)]),
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
