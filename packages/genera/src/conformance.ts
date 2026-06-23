import { beforeEach, describe, expect, it } from "vitest";

import { createStorage } from "./manager";
import { toBytes } from "./bytes";
import { Capability } from "./types";
import type { StorageDriver } from "./driver";
import type { StorageEntry } from "./types";

async function collect(iter: AsyncIterable<StorageEntry>): Promise<StorageEntry[]> {
  const out: StorageEntry[] = [];
  for await (const entry of iter) out.push(entry);
  return out;
}

/**
 * The Genera conformance kit.
 *
 * Any driver MUST pass this suite. It is what makes the "swap the driver, your
 * code keeps working" guarantee verifiable rather than aspirational. Run it
 * against every driver (memory, fs, s3, dropbox, …) with a fresh instance.
 *
 * Published as a subpath export so third-party drivers can self-certify:
 *
 *   import { describeConformance } from "@rocketbean/genera/conformance";
 *   describeConformance("MyDriver", () => new MyDriver());
 */
export function describeConformance(name: string, makeDriver: () => StorageDriver): void {
  describe(`conformance: ${name}`, () => {
    let driver: StorageDriver;

    beforeEach(() => {
      driver = makeDriver();
    });

    it("round-trips bytes through put/get", async () => {
      await driver.put("a/b.txt", "hello world");
      const bytes = await driver.get("a/b.txt");
      expect(new TextDecoder().decode(bytes)).toBe("hello world");
    });

    it("reports existence via exists()", async () => {
      expect(await driver.exists("x.txt")).toBe(false);
      await driver.put("x.txt", "y");
      expect(await driver.exists("x.txt")).toBe(true);
    });

    it("throws NotFoundError when getting a missing object", async () => {
      await expect(driver.get("missing.txt")).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    });

    it("deletes objects and is idempotent", async () => {
      await driver.put("d.txt", "data");
      await driver.delete("d.txt");
      expect(await driver.exists("d.txt")).toBe(false);
      await expect(driver.delete("d.txt")).resolves.toBeUndefined();
    });

    it("accepts web-standard byte inputs (Uint8Array, ArrayBuffer, Blob)", async () => {
      await driver.put("u.bin", new Uint8Array([1, 2, 3]));
      expect([...(await driver.get("u.bin"))]).toEqual([1, 2, 3]);

      await driver.put("a.bin", new Uint8Array([4, 5]).buffer);
      expect([...(await driver.get("a.bin"))]).toEqual([4, 5]);

      await driver.put("b.bin", new Blob([new Uint8Array([9])]));
      expect([...(await driver.get("b.bin"))]).toEqual([9]);
    });

    it("groups nested keys into directory entries (non-recursive list)", async () => {
      await driver.put("docs/readme.md", "r");
      await driver.put("docs/sub/inner.md", "i");
      await driver.put("top.txt", "t");

      const entries = await collect(driver.list());
      const tagged = entries.map((e) => `${e.type}:${e.path}`);

      expect(tagged).toContain("file:top.txt");
      expect(tagged).toContain("directory:docs");
      expect(tagged.some((t) => t.includes("inner"))).toBe(false);
    });

    it("returns every file under a prefix (recursive list)", async () => {
      await driver.put("p/a.txt", "a");
      await driver.put("p/q/b.txt", "b");

      const entries = await collect(driver.list("p", { recursive: true }));
      const files = entries
        .filter((e) => e.type === "file")
        .map((e) => e.path)
        .sort();

      expect(files).toEqual(["p/a.txt", "p/q/b.txt"]);
    });

    it("rejects path traversal with InvalidPathError", async () => {
      await expect(driver.put("../escape.txt", "x")).rejects.toMatchObject({
        code: "INVALID_PATH",
      });
    });

    it("exposes a native identifier via resolveNativeId()", async () => {
      await driver.put("native/id.txt", "x");
      const id = await driver.resolveNativeId("native/id.txt");
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    });

    it("declares capabilities and runtime environments", () => {
      expect(driver.capabilities).toBeInstanceOf(Set);
      expect(driver.environments.size).toBeGreaterThan(0);
    });

    describe("capability dispatch", () => {
      it("copies when Capability.Copy is advertised", async () => {
        if (!driver.capabilities.has(Capability.Copy)) return;
        const disk = createStorage(driver);
        await disk.put("cp/src.txt", "payload");
        await disk.copy("cp/src.txt", "cp/dst.txt");
        expect(new TextDecoder().decode(await disk.get("cp/dst.txt"))).toBe("payload");
        expect(await disk.exists("cp/src.txt")).toBe(true);
      });

      it("moves when Capability.Move is advertised", async () => {
        if (!driver.capabilities.has(Capability.Move)) return;
        const disk = createStorage(driver);
        await disk.put("mv/src.txt", "payload");
        await disk.move("mv/src.txt", "mv/dst.txt");
        expect(new TextDecoder().decode(await disk.get("mv/dst.txt"))).toBe("payload");
        expect(await disk.exists("mv/src.txt")).toBe(false);
      });

      it("exposes metadata via stat when Capability.Stat is advertised", async () => {
        if (!driver.capabilities.has(Capability.Stat)) return;
        const disk = createStorage(driver);
        await disk.put("st/file.txt", "12345");
        const entry = await disk.stat("st/file.txt");
        expect(entry.type).toBe("file");
        expect(entry.size).toBe(5);
      });

      it("rejects an unadvertised capability with OperationNotSupportedError", async () => {
        if (driver.capabilities.has(Capability.SignedUrl)) return;
        const disk = createStorage(driver);
        await expect(disk.getSignedUrl("x.txt")).rejects.toMatchObject({
          code: "OPERATION_NOT_SUPPORTED",
        });
      });

      it("streams bytes back via getStream when Capability.Stream is advertised", async () => {
        if (!driver.capabilities.has(Capability.Stream)) return;
        const disk = createStorage(driver);
        await disk.put("stream/out.bin", new Uint8Array([1, 2, 3, 4, 5]));
        const stream = await disk.getStream("stream/out.bin");
        expect(stream).toBeInstanceOf(ReadableStream);
        expect([...(await toBytes(stream))]).toEqual([1, 2, 3, 4, 5]);
      });

      it("accepts a ReadableStream in put when Capability.Stream is advertised", async () => {
        if (!driver.capabilities.has(Capability.Stream)) return;
        const disk = createStorage(driver);
        const source = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("streamed input"));
            controller.close();
          },
        });
        await disk.put("stream/in.txt", source);
        expect(new TextDecoder().decode(await disk.get("stream/in.txt"))).toBe("streamed input");
      });
    });
  });
}
