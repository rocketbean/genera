import type { StorageDriver } from "./driver";
import type {
  Capability,
  Environment,
  ListOptions,
  PutData,
  PutOptions,
  SignedUrlOptions,
  StorageEntry,
} from "./types";

/**
 * Base for composable wrapper (decorator) drivers (plan §7.1). Delegates every
 * member to the wrapped `inner` driver so subclasses override only what they
 * change — enabling encryption-at-rest, caching, mirroring/failover, logging,
 * etc. on top of any driver. `native` exposes the inner driver.
 *
 * The optional capability methods are delegated unconditionally; the `Disk` only
 * calls them when the (possibly subclass-narrowed) `capabilities` advertises them.
 */
export abstract class WrapperDriver<TInner extends StorageDriver = StorageDriver>
  implements StorageDriver<TInner>
{
  constructor(protected readonly inner: TInner) {}

  get capabilities(): ReadonlySet<Capability> {
    return this.inner.capabilities;
  }

  get environments(): ReadonlySet<Environment> {
    return this.inner.environments;
  }

  get native(): TInner {
    return this.inner;
  }

  put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    return this.inner.put(path, data, opts);
  }

  get(path: string): Promise<Uint8Array> {
    return this.inner.get(path);
  }

  list(prefix?: string, opts?: ListOptions): AsyncIterable<StorageEntry> {
    return this.inner.list(prefix, opts);
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(path);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  resolveNativeId(path: string): Promise<string> {
    return this.inner.resolveNativeId(path);
  }

  copy(from: string, to: string): Promise<StorageEntry> {
    return this.inner.copy!(from, to);
  }

  move(from: string, to: string): Promise<StorageEntry> {
    return this.inner.move!(from, to);
  }

  stat(path: string): Promise<StorageEntry> {
    return this.inner.stat!(path);
  }

  getSignedUrl(path: string, opts?: SignedUrlOptions): Promise<string> {
    return this.inner.getSignedUrl!(path, opts);
  }

  createDirectory(path: string): Promise<void> {
    return this.inner.createDirectory!(path);
  }

  deleteDirectory(path: string): Promise<void> {
    return this.inner.deleteDirectory!(path);
  }
}
