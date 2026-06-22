import { toBytes } from "./bytes";
import { WrapperDriver } from "./wrapper";
import { Capability } from "./types";
import type { StorageDriver } from "./driver";
import type { PutData, PutOptions, StorageEntry } from "./types";

const IV_BYTES = 12; // AES-GCM standard nonce length

// Encryption changes the stored bytes and their length, so these capabilities
// can't pass through transparently: `stat`/`list` sizes would be ciphertext sizes,
// a `getSignedUrl` would hand out a link to ciphertext, and streaming chunk
// boundaries don't line up with GCM. They are dropped from what's advertised.
const EXCLUDED: readonly Capability[] = [
  Capability.Stat,
  Capability.SignedUrl,
  Capability.PublicUrl,
  Capability.Stream,
  Capability.Append,
];

export interface EncryptionDriverOptions {
  /** An AES-GCM `CryptoKey`. Build one with `importAesGcmKey` or `crypto.subtle.generateKey`. */
  key: CryptoKey;
}

/** Import 32 raw bytes (256-bit) as an AES-GCM key (isomorphic via Web Crypto). */
export function importAesGcmKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", rawKey as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Encryption-at-rest wrapper (plan §7.1). Encrypts payloads with AES-256-GCM
 * (a fresh random IV per object, prepended to the ciphertext) before delegating
 * to the inner driver, and decrypts on read. Isomorphic — Web Crypto only.
 *
 * Transparent to `put`/`get`/`list`/`delete`/`copy`/`move`; it narrows
 * `capabilities` (dropping size/URL/stream-dependent ones) so it still passes the
 * conformance kit on top of any driver.
 */
export class EncryptionDriver<
  TInner extends StorageDriver = StorageDriver,
> extends WrapperDriver<TInner> {
  private readonly key: CryptoKey;

  constructor(inner: TInner, options: EncryptionDriverOptions) {
    super(inner);
    this.key = options.key;
  }

  override get capabilities(): ReadonlySet<Capability> {
    return new Set([...this.inner.capabilities].filter((c) => !EXCLUDED.includes(c)));
  }

  override async put(path: string, data: PutData, opts?: PutOptions): Promise<StorageEntry> {
    const plaintext = await toBytes(data);
    const entry = await this.inner.put(path, await this.encrypt(plaintext), opts);
    // Report the plaintext size, not the (larger) ciphertext size.
    return { ...entry, size: plaintext.byteLength };
  }

  override async get(path: string): Promise<Uint8Array> {
    return this.decrypt(await this.inner.get(path));
  }

  private async encrypt(data: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        this.key,
        data as BufferSource,
      ),
    );
    const out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
    out.set(iv, 0);
    out.set(ciphertext, IV_BYTES);
    return out;
  }

  private async decrypt(data: Uint8Array): Promise<Uint8Array> {
    const iv = data.subarray(0, IV_BYTES);
    const ciphertext = data.subarray(IV_BYTES);
    return new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: iv as BufferSource },
        this.key,
        ciphertext as BufferSource,
      ),
    );
  }
}
