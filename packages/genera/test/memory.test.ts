import { describe, expect, it } from "vitest";
import { createStorage, MemoryDriver } from "../src/index";
import { describeConformance } from "../src/conformance";

// MemoryDriver must satisfy the full contract.
describeConformance("MemoryDriver", () => new MemoryDriver());

describe("MemoryDriver escape hatch", () => {
  it("narrows via Disk.as() and exposes the native store", async () => {
    const storage = createStorage(new MemoryDriver());
    await storage.put("k.txt", "v");

    const driver = storage.as(MemoryDriver);
    expect(driver.native).toBeInstanceOf(Map);
    expect(driver.native.size).toBe(1);

    const id = await driver.resolveNativeId("k.txt");
    expect(driver.native.has(id)).toBe(true);
  });

  it("throws DriverMismatchError when narrowing to the wrong driver", () => {
    const storage = createStorage(new MemoryDriver());
    class OtherDriver extends MemoryDriver {}
    expect(() => storage.as(OtherDriver)).toThrow(/not an instance/);
  });
});

describe("root scoping", () => {
  it("confines paths under the configured root", async () => {
    const storage = createStorage(new MemoryDriver({ root: "tenant-123" }));
    await storage.put("file.txt", "scoped");

    const driver = storage.as(MemoryDriver);
    // The native key is prefixed, but the user-facing path is not.
    expect(driver.native.has("tenant-123/file.txt")).toBe(true);
    expect(await storage.exists("file.txt")).toBe(true);
  });
});
