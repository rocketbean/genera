import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve as resolveFsPath, sep } from "node:path";

import { BaseDriver, type DriverOptions } from "../driver";
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

/** Minimal shape of the parts of `fs.Stats` the driver needs. */
interface FsStats {
  size: number;
  mtime: Date;
  isDirectory(): boolean;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === code
  );
}

export interface FsDriverOptions extends DriverOptions {
  /** Directory on disk (absolute, or resolved against cwd) that backs this driver. */
  baseDir: string;
}

/**
 * Local-filesystem reference driver. Node-only by nature (`node:fs/promises`), so
 * it declares only the `node` environment and lives behind the `@rocketbean/genera/node`
 * subpath — keeping the isomorphic core free of Node built-ins (plan §5.3, §5.6).
 *
 * Key-native: the canonical path maps directly to a path under `baseDir`, and the
 * absolute filesystem path is the native identifier. Real directories are created
 * as needed, so `put("a/b/c.txt")` works without explicit folder creation.
 */
export class FsDriver extends BaseDriver<string> {
  readonly capabilities: ReadonlySet<Capability> = new Set([
    Capability.Copy,
    Capability.Move,
    Capability.Stat,
    Capability.CreateDirectory,
    Capability.DeleteDirectory,
  ]);
  readonly environments: ReadonlySet<Environment> = new Set<Environment>(["node"]);

  private readonly baseDir: string;

  constructor(options: FsDriverOptions) {
    super(options);
    this.baseDir = resolveFsPath(options.baseDir);
  }

  get native(): string {
    return this.baseDir;
  }

  /** Canonical (root-scoped) key -> absolute filesystem path. */
  private toFsPath(key: string): string {
    return key === "" ? this.baseDir : join(this.baseDir, ...key.split("/"));
  }

  /** Absolute filesystem path -> canonical (root-scoped) key. */
  private toKey(fsPath: string): string {
    return relative(this.baseDir, fsPath).split(sep).join("/");
  }

  async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const key = this.resolve(path);
    const fsPath = this.toFsPath(key);
    if (opts?.overwrite === false) {
      try {
        await access(fsPath);
        throw new AlreadyExistsError(`Object already exists at "${path}"`);
      } catch (error) {
        if (error instanceof AlreadyExistsError) throw error;
        if (!isErrno(error, "ENOENT")) throw error;
      }
    }
    await mkdir(dirname(fsPath), { recursive: true });
    await writeFile(fsPath, await toBytes(data));
    return this.entryFor(key, (await stat(fsPath)) as FsStats);
  }

  async get(path: string): Promise<Uint8Array> {
    const fsPath = this.toFsPath(this.resolve(path));
    try {
      return new Uint8Array(await readFile(fsPath));
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new NotFoundError(`No object found at "${path}"`);
      throw error;
    }
  }

  async *list(prefix = "", opts?: ListOptions): AsyncIterable<StorageEntry> {
    const recursive = opts?.recursive ?? false;
    const scopeKey = prefix ? this.resolve(prefix) : this.root;
    const limit = opts?.limit;

    let count = 0;
    for await (const entry of this.walk(this.toFsPath(scopeKey), recursive)) {
      if (limit !== undefined && count >= limit) return;
      yield entry;
      count++;
    }
  }

  private async *walk(dir: string, recursive: boolean): AsyncIterable<StorageEntry> {
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, "ENOENT")) return; // listing a missing prefix yields nothing
      throw error;
    }

    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      const fsPath = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        if (recursive) {
          yield* this.walk(fsPath, true);
        } else {
          yield {
            path: this.unresolve(this.toKey(fsPath)),
            name: dirent.name,
            type: "directory",
          };
        }
      } else if (dirent.isFile()) {
        yield this.entryFor(this.toKey(fsPath), (await stat(fsPath)) as FsStats);
      }
    }
  }

  async delete(path: string): Promise<void> {
    // Idempotent, matching object-store semantics: `force` ignores a missing path.
    await rm(this.toFsPath(this.resolve(path)), { force: true });
  }

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.toFsPath(this.resolve(path)));
      return true;
    } catch {
      return false;
    }
  }

  async resolveNativeId(path: string): Promise<string> {
    // FS is key-native: the absolute filesystem path is the native identifier.
    return this.toFsPath(this.resolve(path));
  }

  // --- Capability-gated operations (advertised in `capabilities` above) ---

  async copy(from: string, to: string): Promise<StorageEntry> {
    const fromPath = this.toFsPath(this.resolve(from));
    const toKey = this.resolve(to);
    const toPath = this.toFsPath(toKey);
    await mkdir(dirname(toPath), { recursive: true });
    try {
      await copyFile(fromPath, toPath);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new NotFoundError(`No object found at "${from}"`);
      throw error;
    }
    return this.entryFor(toKey, (await stat(toPath)) as FsStats);
  }

  async move(from: string, to: string): Promise<StorageEntry> {
    const fromPath = this.toFsPath(this.resolve(from));
    const toKey = this.resolve(to);
    const toPath = this.toFsPath(toKey);
    await mkdir(dirname(toPath), { recursive: true });
    try {
      await rename(fromPath, toPath);
    } catch (error) {
      if (isErrno(error, "EXDEV")) {
        // Cross-device rename isn't allowed; fall back to copy + delete.
        await copyFile(fromPath, toPath);
        await rm(fromPath, { force: true });
      } else if (isErrno(error, "ENOENT")) {
        throw new NotFoundError(`No object found at "${from}"`);
      } else {
        throw error;
      }
    }
    return this.entryFor(toKey, (await stat(toPath)) as FsStats);
  }

  async stat(path: string): Promise<StorageEntry> {
    const key = this.resolve(path);
    try {
      const stats = (await stat(this.toFsPath(key))) as FsStats;
      if (stats.isDirectory()) {
        return { path: this.unresolve(key), name: basename(key), type: "directory" };
      }
      return this.entryFor(key, stats);
    } catch (error) {
      if (isErrno(error, "ENOENT"))
        throw new NotFoundError(`No object found at "${path}"`);
      throw error;
    }
  }

  async createDirectory(path: string): Promise<void> {
    await mkdir(this.toFsPath(this.resolve(path)), { recursive: true });
  }

  async deleteDirectory(path: string): Promise<void> {
    await rm(this.toFsPath(this.resolve(path)), { recursive: true, force: true });
  }

  private entryFor(key: string, stats: FsStats): StorageEntry {
    const objectPath = this.unresolve(key);
    return {
      path: objectPath,
      name: basename(objectPath),
      type: "file",
      size: stats.size,
      modifiedAt: stats.mtime,
    };
  }
}
