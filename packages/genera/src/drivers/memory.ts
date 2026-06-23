import { BaseDriver } from "../driver";
import { toBytes } from "../bytes";
import { basename } from "../path";
import { AlreadyExistsError, NotFoundError } from "../errors";
import {
  Capability,
  type Environment,
  type ListOptions,
  type PutData,
  type PutOptions,
  type StorageEntry,
} from "../types";

/** What the MemoryDriver keeps per object. Exposed as the driver's `native` type. */
export interface StoredObject {
  bytes: Uint8Array;
  contentType: string | undefined;
  metadata: Record<string, string> | undefined;
  modifiedAt: Date;
}

/**
 * In-memory, zero-dependency, fully isomorphic reference driver.
 * It is the conformance-kit substrate and a faithful example of the contract:
 * key-native addressing, virtual folders, idempotent delete.
 */
export class MemoryDriver extends BaseDriver<Map<string, StoredObject>> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
    Capability.Stream,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>([
    "node",
    "browser",
  ]);

  private readonly store = new Map<string, StoredObject>();

  get native(): Map<string, StoredObject> {
    return this.store;
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    if (opts?.overwrite === false && this.store.has(key)) {
      throw new AlreadyExistsError(`Object already exists at "${path}"`);
    }
    const object: StoredObject = {
      bytes: await toBytes(data),
      contentType: opts?.contentType,
      metadata: opts?.metadata,
      modifiedAt: new Date(),
    };
    this.store.set(key, object);
    return this.entryFor(key, object);
  }

  async get(path: string): Promise<Uint8Array> {
    const object = this.store.get(this.resolve(path));
    if (!object) {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    return object.bytes;
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scope = prefix ? this.resolve(prefix) : this.root;
    const base = scope ? `${scope}/` : "";

    const entries: StorageEntry[] = [];
    const seenDirs = new Set<string>();

    for (const [key, object] of this.store) {
      if (base && !key.startsWith(base)) continue;
      const rest = base ? key.slice(base.length) : key;
      if (rest === "") continue;

      const slash = rest.indexOf("/");
      if (recursive || slash === -1) {
        entries.push(this.entryFor(key, object));
      } else {
        const dirName = rest.slice(0, slash);
        const dirKey = `${base}${dirName}`;
        if (!seenDirs.has(dirKey)) {
          seenDirs.add(dirKey);
          entries.push({
            path: this.unresolve(dirKey),
            name: dirName,
            type: "directory",
          });
        }
      }
    }

    const limited = opts?.limit !== undefined ? entries.slice(0, opts.limit) : entries;
    for (const entry of limited) {
      yield entry;
    }
  }

  async delete(path: string): Promise<void> {
    // Idempotent, matching object-store semantics: deleting a missing key is a no-op.
    this.store.delete(this.resolve(path));
  }

  async exists(path: string): Promise<boolean> {
    return this.store.has(this.resolve(path));
  }

  async resolveNativeId(path: string): Promise<string> {
    // Memory is key-native: the resolved key *is* the native identifier.
    return this.resolve(path);
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const source = this.store.get(this.resolve(from));
    if (!source) {
      throw new NotFoundError(`No object found at "${from}"`);
    }
    const destKey = this.resolve(to);
    const copied: StoredObject = {
      ...source,
      bytes: source.bytes.slice(),
      modifiedAt: new Date(),
    };
    this.store.set(destKey, copied);
    return this.entryFor(destKey, copied);
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const entry = await this.copy(from, to);
    this.store.delete(this.resolve(from));
    return entry;
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    const object = this.store.get(key);
    if (!object) {
      throw new NotFoundError(`No object found at "${path}"`);
    }
    return this.entryFor(key, object);
  }

  async getStream(path: string): Promise<ReadableStream<Uint8Array>> {
    const bytes = await this.get(path); // throws NotFoundError if absent
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  private entryFor(key: string, object: StoredObject): StorageEntry {
    const objectPath = this.unresolve(key);
    const entry: StorageEntry = {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: object.bytes.byteLength,
      modifiedAt: object.modifiedAt,
    };
    if (object.metadata !== undefined) {
      entry.metadata = object.metadata;
    }
    return entry;
  }
}
