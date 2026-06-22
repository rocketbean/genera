import { describe, expect, it } from "vitest";

import { MemoryDriver, transfer } from "../src/index";

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("transfer", () => {
  it("copies every file from one driver to another", async () => {
    const source = new MemoryDriver();
    const dest = new MemoryDriver();
    await source.put("a.txt", "one");
    await source.put("nested/b.txt", "two");
    await source.put("nested/deep/c.txt", "three");

    const result = await transfer(source, dest, {});

    expect(result.files).toBe(3);
    expect(result.bytes).toBe("one".length + "two".length + "three".length);
    expect(decode(await dest.get("a.txt"))).toBe("one");
    expect(decode(await dest.get("nested/deep/c.txt"))).toBe("three");
  });

  it("limits the copy to a prefix", async () => {
    const source = new MemoryDriver();
    const dest = new MemoryDriver();
    await source.put("keep/x.txt", "x");
    await source.put("skip/y.txt", "y");

    const result = await transfer(source, dest, { prefix: "keep" });

    expect(result.files).toBe(1);
    expect(await dest.exists("keep/x.txt")).toBe(true);
    expect(await dest.exists("skip/y.txt")).toBe(false);
  });
});
