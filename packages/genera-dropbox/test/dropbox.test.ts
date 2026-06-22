import { describe, expect, it } from "vitest";
import { Dropbox } from "dropbox";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { DropboxDriver } from "../src/index";

/**
 * A stateful in-memory fake of the bits of the Dropbox SDK the driver uses. It
 * mirrors Dropbox's path semantics (leading slash, `""` root, folder entries
 * synthesized from file paths) so the full conformance kit runs offline. The
 * env-gated block below runs the same kit against a real account.
 */
type AnyArgs = {
  path?: string | undefined;
  contents?: unknown;
  from_path?: string | undefined;
  to_path?: string | undefined;
};

class FakeDropbox {
  private files = new Map<string, { bytes: Uint8Array; modified: Date }>();

  private notFound(): never {
    // eslint-disable-next-line no-throw-literal
    throw { status: 409, error: { error_summary: "path/not_found/." } };
  }

  private fileMeta(path: string) {
    const file = this.files.get(path)!;
    return {
      ".tag": "file" as const,
      name: path.split("/").pop(),
      path_display: path,
      path_lower: path.toLowerCase(),
      id: `id:${path}`,
      size: file.bytes.byteLength,
      server_modified: file.modified.toISOString(),
      content_hash: "deadbeefdeadbeef",
    };
  }

  private folderMeta(path: string) {
    return {
      ".tag": "folder" as const,
      name: path.split("/").pop(),
      path_display: path,
      path_lower: path.toLowerCase(),
      id: `id:${path}`,
    };
  }

  filesUpload({ path, contents }: AnyArgs) {
    this.files.set(path!, {
      bytes: new Uint8Array(contents as Uint8Array),
      modified: new Date(),
    });
    return Promise.resolve({ result: this.fileMeta(path!) });
  }

  filesDownload({ path }: AnyArgs) {
    if (!this.files.has(path!)) this.notFound();
    return Promise.resolve({
      result: { ...this.fileMeta(path!), fileBinary: Buffer.from(this.files.get(path!)!.bytes) },
    });
  }

  filesGetMetadata({ path }: AnyArgs) {
    if (this.files.has(path!)) return Promise.resolve({ result: this.fileMeta(path!) });
    const prefix = `${path}/`;
    for (const p of this.files.keys()) {
      if (p.startsWith(prefix)) return Promise.resolve({ result: this.folderMeta(path!) });
    }
    this.notFound();
  }

  filesListFolder({ path, recursive }: AnyArgs & { recursive?: boolean }) {
    const base = path === "" ? "/" : `${path}/`;
    const entries: unknown[] = [];
    const dirs = new Set<string>();
    for (const p of this.files.keys()) {
      if (!p.startsWith(base)) continue;
      const rest = p.slice(base.length);
      if (rest === "") continue;
      const slash = rest.indexOf("/");
      if (recursive || slash === -1) {
        entries.push(this.fileMeta(p));
      } else {
        const dirPath = base + rest.slice(0, slash);
        if (!dirs.has(dirPath)) {
          dirs.add(dirPath);
          entries.push(this.folderMeta(dirPath));
        }
      }
    }
    return Promise.resolve({ result: { entries, cursor: "END", has_more: false } });
  }

  filesListFolderContinue() {
    return Promise.resolve({ result: { entries: [], cursor: "END", has_more: false } });
  }

  filesDeleteV2({ path }: AnyArgs) {
    if (this.files.has(path!)) {
      const meta = this.fileMeta(path!);
      this.files.delete(path!);
      return Promise.resolve({ result: { metadata: meta } });
    }
    const prefix = `${path}/`;
    let deleted = false;
    for (const p of [...this.files.keys()]) {
      if (p.startsWith(prefix)) {
        this.files.delete(p);
        deleted = true;
      }
    }
    if (!deleted) this.notFound();
    return Promise.resolve({ result: { metadata: this.folderMeta(path!) } });
  }

  filesCopyV2({ from_path, to_path }: AnyArgs) {
    if (!this.files.has(from_path!)) this.notFound();
    this.files.set(to_path!, {
      bytes: new Uint8Array(this.files.get(from_path!)!.bytes),
      modified: new Date(),
    });
    return Promise.resolve({ result: { metadata: this.fileMeta(to_path!) } });
  }

  async filesMoveV2({ from_path, to_path }: AnyArgs) {
    const result = await this.filesCopyV2({ from_path, to_path });
    this.files.delete(from_path!);
    return result;
  }

  filesCreateFolderV2({ path }: AnyArgs) {
    return Promise.resolve({ result: { metadata: this.folderMeta(path!) } });
  }

  sharingCreateSharedLinkWithSettings({ path }: AnyArgs) {
    return Promise.resolve({ result: { url: `https://www.dropbox.com/s/fake${path}?dl=0` } });
  }
}

function fakeClient(): Dropbox {
  return new FakeDropbox() as unknown as Dropbox;
}

// The linchpin: the Dropbox driver must satisfy the full portable contract.
describeConformance("Dropbox (fake)", () => new DropboxDriver({ client: fakeClient() }));

describe("DropboxDriver specifics", () => {
  it("is isomorphic and exposes the injected client as native", () => {
    const client = fakeClient();
    const driver = new DropboxDriver({ client });
    expect(driver.environments.has("node")).toBe(true);
    expect(driver.environments.has("browser")).toBe(true);
    expect(driver.native).toBe(client);
  });

  it("is path-native: resolveNativeId returns the (root-scoped) Dropbox path", async () => {
    const driver = new DropboxDriver({ client: fakeClient(), root: "tenant" });
    expect(await driver.resolveNativeId("a/b.txt")).toBe("/tenant/a/b.txt");
  });

  it("throws AlreadyExistsError when overwrite is false", async () => {
    const storage = createStorage(new DropboxDriver({ client: fakeClient() }));
    await storage.put("once.txt", "first");
    await expect(
      storage.unwrap().put("once.txt", "second", { overwrite: false }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("creates a shared link for getSignedUrl", async () => {
    const driver = new DropboxDriver({ client: fakeClient() });
    await driver.put("shared.txt", "x");
    expect(await driver.getSignedUrl("shared.txt")).toContain("shared.txt");
  });

  it("requires some form of auth", () => {
    expect(() => new DropboxDriver({})).toThrow();
  });
});

// Optional live run against a real Dropbox account:
//   GENERA_DROPBOX_TEST_TOKEN=<access-token> pnpm --filter @rocketbean/genera-dropbox test
const LIVE_TOKEN = process.env.GENERA_DROPBOX_TEST_TOKEN;
if (LIVE_TOKEN) {
  describeConformance(
    "Dropbox (live)",
    () =>
      new DropboxDriver({
        accessToken: LIVE_TOKEN,
        root: `genera-conformance/conf-${crypto.randomUUID()}`,
      }),
  );
} else {
  describe.skip("Dropbox (live — set GENERA_DROPBOX_TEST_TOKEN to run)", () => {
    it("skipped", () => {});
  });
}
