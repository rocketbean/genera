/**
 * Public types shared across the whole library.
 *
 * Byte types are deliberately web-standard so the contract is isomorphic
 * (browser + Node). On Node, `Buffer` satisfies `Uint8Array`, so it is accepted too.
 */

/** A single entry returned by `list()` — uniform across every driver. */
export interface StorageEntry {
  /** Canonical virtual path, e.g. "users/42/avatar.png". */
  path: string;
  /** Last path segment, e.g. "avatar.png". */
  name: string;
  type: "file" | "directory";
  /** Size in bytes (files only). */
  size?: number;
  modifiedAt?: Date;
  etag?: string;
  metadata?: Record<string, string>;
}

/** Accepted input for `put()`. All members exist in both the browser and Node 18+. */
export type PutData = string | Uint8Array | ArrayBuffer | Blob | ReadableStream;

export interface PutOptions {
  contentType?: string;
  metadata?: Record<string, string>;
  /** When false, fail instead of overwriting an existing object. Defaults to true. */
  overwrite?: boolean;
}

export interface ListOptions {
  /** Recurse into nested "folders" instead of returning one level. Defaults to false. */
  recursive?: boolean;
  /** Cap the number of entries returned. */
  limit?: number;
}

/** Options for the capability-gated `getSignedUrl()` operation (`Capability.SignedUrl`). */
export interface SignedUrlOptions {
  /** Seconds until the URL expires. Drivers pick a sane default if omitted. */
  expiresIn?: number;
  /** Whether the URL grants read or write access. Defaults to "read". */
  action?: "read" | "write";
}

/**
 * Optional, capability-gated operations. A driver advertises what it supports via
 * `driver.capabilities`; calling an unsupported one throws `OperationNotSupportedError`.
 */
export enum Capability {
  SignedUrl = "signed-url",
  PublicUrl = "public-url",
  Stream = "stream",
  Copy = "copy",
  Move = "move",
  Stat = "stat",
  CreateDirectory = "create-directory",
  DeleteDirectory = "delete-directory",
  Append = "append",
}

/** Runtimes a driver can run in. The core is universal; drivers may be scoped. */
export type Environment = "node" | "browser";
