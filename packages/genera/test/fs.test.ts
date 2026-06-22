import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStorage } from "../src/index";
import { FsDriver } from "../src/node";
import { describeConformance } from "../src/conformance";

const tempDirs: string[] = [];

function freshFsDriver(): FsDriver {
  const dir = mkdtempSync(join(tmpdir(), "genera-fs-"));
  tempDirs.push(dir);
  return new FsDriver({ baseDir: dir });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

// The FsDriver must satisfy the full contract — Phase 1 exit criterion.
describeConformance("FsDriver", freshFsDriver);

describe("FsDriver specifics", () => {
  it("is Node-only and exposes its base directory as native", () => {
    const driver = freshFsDriver();
    expect(driver.environments.has("node")).toBe(true);
    expect(driver.environments.has("browser")).toBe(false);
    expect(typeof driver.native).toBe("string");
  });

  it("auto-creates real nested directories on put()", async () => {
    const storage = createStorage(freshFsDriver());
    await storage.put("a/b/c.txt", "deep");
    expect(new TextDecoder().decode(await storage.get("a/b/c.txt"))).toBe("deep");
  });

  it("scopes paths under the configured root on disk", async () => {
    const driver = freshFsDriver();
    const storage = createStorage(
      new FsDriver({ baseDir: driver.native, root: "tenant" }),
    );
    await storage.put("file.txt", "scoped");
    expect(await storage.exists("file.txt")).toBe(true);
    // Reading the same physical file through an unscoped driver confirms the prefix.
    const unscoped = createStorage(new FsDriver({ baseDir: driver.native }));
    expect(new TextDecoder().decode(await unscoped.get("tenant/file.txt"))).toBe(
      "scoped",
    );
  });
});
