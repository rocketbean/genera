import type { StorageDriver } from "./driver";

export interface TransferOptions {
  /** Limit the copy to paths under this prefix. Default: everything. */
  prefix?: string;
  /** When false, skip (don't overwrite) files that already exist at the destination. */
  overwrite?: boolean;
}

export interface TransferResult {
  files: number;
  bytes: number;
}

/**
 * Cross-provider migration/sync utility (plan §7): copy every file under `prefix`
 * from one driver to another. Works between any two drivers (e.g. S3 → GCS,
 * Dropbox → Box) because both speak the same portable contract. Returns how many
 * files and bytes were transferred.
 */
export async function transfer(
  source: StorageDriver,
  dest: StorageDriver,
  options: TransferOptions = {},
): Promise<TransferResult> {
  let files = 0;
  let bytes = 0;
  for await (const entry of source.list(options.prefix ?? "", { recursive: true })) {
    if (entry.type !== "file") continue;
    const data = await source.get(entry.path);
    await dest.put(entry.path, data, options.overwrite === false ? { overwrite: false } : undefined);
    files += 1;
    bytes += data.byteLength;
  }
  return { files, bytes };
}
