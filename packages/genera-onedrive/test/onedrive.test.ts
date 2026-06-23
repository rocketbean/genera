import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import { Client, ResponseType } from "@microsoft/microsoft-graph-client";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { OneDriveDriver } from "../src/index";

/**
 * A stateful in-memory fake of the Microsoft Graph fluent client (`api().get()` /
 * `.put()` / `.post()` / `.delete()`), mirroring the `/me/drive/root:/path:`
 * addressing so the full conformance kit runs offline. The env-gated block runs
 * the same kit against a real account.
 */
type Stored = { bytes: Uint8Array; modified: Date };

function graphNotFound(): { statusCode: number; code: string } {
  return { statusCode: 404, code: "itemNotFound" };
}

function parseResource(resource: string): { key: string | undefined; verb: string | undefined } {
  const match = resource.match(/^\/me\/drive\/root(?::\/(.+?):)?(?:\/(.+))?$/);
  return { key: match?.[1], verb: match?.[2] };
}

class FakeRequest {
  private resType: unknown;
  private hdrs: Record<string, unknown> = {};

  constructor(
    private readonly store: Map<string, Stored>,
    private readonly sessions: Map<string, Uint8Array[]>,
    private readonly resource: string,
  ) {}

  responseType(type: unknown): this {
    this.resType = type;
    return this;
  }

  headers(headers: Record<string, unknown>): this {
    this.hdrs = { ...this.hdrs, ...headers };
    return this;
  }

  get(): Promise<unknown> {
    const { key, verb } = parseResource(this.resource);
    if (verb === "content") {
      const file = this.store.get(key!);
      if (!file) return Promise.reject(graphNotFound());
      if (this.resType === ResponseType.STREAM) {
        return Promise.resolve(Readable.from(Buffer.from(file.bytes)));
      }
      return Promise.resolve(file.bytes.slice().buffer);
    }
    if (verb === "children") return Promise.resolve({ value: this.childrenOf(key ?? "") });
    if (key === undefined) return Promise.resolve(this.folderItem(""));
    if (this.store.has(key)) return Promise.resolve(this.fileItem(key));
    if (this.isFolder(key)) return Promise.resolve(this.folderItem(key));
    return Promise.reject(graphNotFound());
  }

  put(content: unknown): Promise<unknown> {
    // Upload-session chunk PUT to the absolute uploadUrl.
    if (this.resource.startsWith("https://fake-upload/")) {
      const key = decodeURIComponent(this.resource.slice("https://fake-upload/".length));
      const chunks = this.sessions.get(key) ?? [];
      chunks.push(new Uint8Array(content as Uint8Array));
      this.sessions.set(key, chunks);
      const range = String(this.hdrs["Content-Range"] ?? "");
      const m = range.match(/bytes (\d+)-(\d+)\/(\d+)/);
      const isFinal = !m || Number(m[2]) === Number(m[3]) - 1;
      if (!isFinal) return Promise.resolve({});
      let total = 0;
      for (const c of chunks) total += c.byteLength;
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        bytes.set(c, offset);
        offset += c.byteLength;
      }
      this.store.set(key, { bytes, modified: new Date() });
      this.sessions.delete(key);
      return Promise.resolve(this.fileItem(key));
    }
    const { key } = parseResource(this.resource);
    this.store.set(key!, { bytes: new Uint8Array(content as Uint8Array), modified: new Date() });
    return Promise.resolve(this.fileItem(key!));
  }

  post(): Promise<unknown> {
    const { key, verb } = parseResource(this.resource);
    if (verb === "createUploadSession") {
      return Promise.resolve({ uploadUrl: `https://fake-upload/${encodeURIComponent(key ?? "")}` });
    }
    if (verb === "createLink") {
      return Promise.resolve({ link: { webUrl: `https://1drv.ms/${key}` } });
    }
    return Promise.resolve({ id: "folder", folder: {} });
  }

  delete(): Promise<void> {
    const { key } = parseResource(this.resource);
    if (this.store.has(key!)) {
      this.store.delete(key!);
      return Promise.resolve();
    }
    if (this.isFolder(key!)) {
      for (const p of [...this.store.keys()]) {
        if (p.startsWith(`${key}/`)) this.store.delete(p);
      }
      return Promise.resolve();
    }
    return Promise.reject(graphNotFound());
  }

  private isFolder(key: string): boolean {
    for (const p of this.store.keys()) if (p.startsWith(`${key}/`)) return true;
    return false;
  }

  private fileItem(key: string): unknown {
    const file = this.store.get(key)!;
    return {
      id: `id:${key}`,
      name: key.split("/").pop(),
      size: file.bytes.byteLength,
      lastModifiedDateTime: file.modified.toISOString(),
      eTag: `"etag-${key}"`,
      file: { mimeType: "application/octet-stream" },
    };
  }

  private folderItem(key: string): unknown {
    return {
      id: `id:${key || "root"}`,
      name: key === "" ? "root" : key.split("/").pop(),
      folder: { childCount: 0 },
    };
  }

  private childrenOf(scopeKey: string): unknown[] {
    const base = scopeKey === "" ? "" : `${scopeKey}/`;
    const out: unknown[] = [];
    const dirs = new Set<string>();
    for (const p of this.store.keys()) {
      if (base && !p.startsWith(base)) continue;
      const rest = base ? p.slice(base.length) : p;
      if (rest === "") continue;
      const slash = rest.indexOf("/");
      if (slash === -1) {
        out.push(this.fileItem(p));
      } else {
        const dirKey = base + rest.slice(0, slash);
        if (!dirs.has(dirKey)) {
          dirs.add(dirKey);
          out.push(this.folderItem(dirKey));
        }
      }
    }
    return out;
  }
}

class FakeGraphClient {
  private readonly store = new Map<string, Stored>();
  private readonly sessions = new Map<string, Uint8Array[]>();
  api(resource: string): FakeRequest {
    return new FakeRequest(this.store, this.sessions, resource);
  }
}

function fakeClient(): Client {
  return new FakeGraphClient() as unknown as Client;
}

// The linchpin: the OneDrive driver must satisfy the full portable contract.
describeConformance("OneDrive (fake)", () => new OneDriveDriver({ client: fakeClient() }));

describe("OneDriveDriver specifics", () => {
  it("is isomorphic and exposes the injected Graph client as native", () => {
    const client = fakeClient();
    const driver = new OneDriveDriver({ client });
    expect(driver.environments.has("node")).toBe(true);
    expect(driver.environments.has("browser")).toBe(true);
    expect(driver.native).toBe(client);
  });

  it("resolveNativeId returns the DriveItem id of the (root-scoped) item", async () => {
    const driver = new OneDriveDriver({ client: fakeClient(), root: "tenant" });
    await driver.put("a/b.txt", "x");
    expect(await driver.resolveNativeId("a/b.txt")).toBe("id:tenant/a/b.txt");
  });

  it("throws AlreadyExistsError when overwrite is false", async () => {
    const storage = createStorage(new OneDriveDriver({ client: fakeClient() }));
    await storage.put("once.txt", "first");
    await expect(
      storage.unwrap().put("once.txt", "second", { overwrite: false }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("creates a sharing link for getSignedUrl", async () => {
    const driver = new OneDriveDriver({ client: fakeClient() });
    await driver.put("shared.txt", "x");
    expect(await driver.getSignedUrl("shared.txt")).toContain("shared.txt");
  });

  it("requires some form of auth", () => {
    expect(() => new OneDriveDriver({})).toThrow();
  });

  it("uploads a stream via a chunked upload session", async () => {
    const driver = new OneDriveDriver({ client: fakeClient(), chunkSize: 4 });
    const payload = "onedrive-upload-session-payload"; // > 4 bytes → ranged chunks
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(payload));
        controller.close();
      },
    });
    await driver.put("big.txt", stream);
    expect(new TextDecoder().decode(await driver.get("big.txt"))).toBe(payload);
  });
});

const LIVE_TOKEN = process.env.GENERA_ONEDRIVE_TEST_TOKEN;
if (LIVE_TOKEN) {
  describeConformance(
    "OneDrive (live)",
    () =>
      new OneDriveDriver({
        accessToken: LIVE_TOKEN,
        root: `genera-conformance/conf-${crypto.randomUUID()}`,
      }),
  );
} else {
  describe.skip("OneDrive (live — set GENERA_ONEDRIVE_TEST_TOKEN to run)", () => {
    it("skipped", () => {});
  });
}
