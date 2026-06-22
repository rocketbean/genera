import { describe, expect, it } from "vitest";

import { describeConformance } from "../src/conformance";
import {
  Capability,
  EncryptionDriver,
  MemoryDriver,
  createStorage,
  importAesGcmKey,
  type StoredObject,
} from "../src/index";

// One AES-256-GCM key for the whole file; each test still gets a fresh inner driver.
const key = await importAesGcmKey(new Uint8Array(32).fill(7));

// A transparent encryption wrapper must still pass the full conformance kit.
describeConformance("EncryptionDriver(Memory)", () => new EncryptionDriver(new MemoryDriver(), { key }));

describe("EncryptionDriver specifics", () => {
  it("stores ciphertext at rest, not plaintext", async () => {
    const inner = new MemoryDriver();
    const driver = new EncryptionDriver(inner, { key });
    await driver.put("secret.txt", "top secret");

    // Reach through to the inner store: the bytes on disk must NOT be the plaintext.
    const store = inner.native as Map<string, StoredObject>;
    const stored = [...store.values()][0]!.bytes;
    expect(new TextDecoder().decode(stored)).not.toContain("top secret");
    // ...but a round-tripped read decrypts back to the original.
    expect(new TextDecoder().decode(await driver.get("secret.txt"))).toBe("top secret");
  });

  it("reports the plaintext size from put (not the ciphertext size)", async () => {
    const driver = new EncryptionDriver(new MemoryDriver(), { key });
    const entry = await driver.put("f.bin", new Uint8Array(100));
    expect(entry.size).toBe(100);
  });

  it("drops size/url-dependent capabilities", () => {
    const driver = new EncryptionDriver(new MemoryDriver(), { key });
    expect(driver.capabilities.has(Capability.Copy)).toBe(true); // transparent on ciphertext
    expect(driver.capabilities.has(Capability.Stat)).toBe(false);
    expect(driver.capabilities.has(Capability.SignedUrl)).toBe(false);
  });

  it("fails to decrypt with the wrong key", async () => {
    const inner = new MemoryDriver();
    await new EncryptionDriver(inner, { key }).put("x.txt", "data");
    const otherKey = await importAesGcmKey(new Uint8Array(32).fill(9));
    await expect(new EncryptionDriver(inner, { key: otherKey }).get("x.txt")).rejects.toThrow();
  });

  it("composes with createStorage", async () => {
    const storage = createStorage(new EncryptionDriver(new MemoryDriver(), { key }));
    await storage.put("note.txt", "hello");
    expect(new TextDecoder().decode(await storage.get("note.txt"))).toBe("hello");
  });
});
