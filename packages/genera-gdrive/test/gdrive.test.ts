import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";
import type { drive_v3 } from "@googleapis/drive";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { GoogleDriveDriver } from "../src/index";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function driveNotFound(): Error {
  return Object.assign(new Error("Not Found"), { code: 404 });
}

async function drain(body: unknown): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return new Uint8Array(body);
  const chunks: Uint8Array[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * A stateful in-memory fake of the bits of `drive_v3.Drive` the driver uses — an
 * ID-native tree (opaque ids, parent links, same-name siblings allowed). Lets the
 * full conformance kit + resolver behaviors run offline.
 */
class FakeFiles {
  private readonly nodes = new Map<
    string,
    { name: string; parentId: string; mimeType: string; bytes?: Uint8Array; modifiedTime: string }
  >();
  private seq = 0;

  list(params: { q?: string }) {
    const q = params.q ?? "";
    const parentId = q.match(/'((?:[^'\\]|\\.)*)' in parents/)?.[1]?.replace(/\\(.)/g, "$1");
    const nameMatch = q.match(/name = '((?:[^'\\]|\\.)*)'/);
    const name = nameMatch ? nameMatch[1]!.replace(/\\(.)/g, "$1") : undefined;
    const files: unknown[] = [];
    for (const [id, n] of this.nodes) {
      if (n.parentId !== parentId) continue;
      if (name !== undefined && n.name !== name) continue;
      files.push({
        id,
        name: n.name,
        mimeType: n.mimeType,
        size: n.bytes ? String(n.bytes.byteLength) : undefined,
        modifiedTime: n.modifiedTime,
        md5Checksum: "md5",
      });
    }
    return Promise.resolve({ data: { files, nextPageToken: undefined } });
  }

  async create(params: {
    requestBody: { name: string; mimeType?: string; parents?: string[] };
    media?: { body: unknown };
  }) {
    const id = `f${++this.seq}`;
    const node = {
      name: params.requestBody.name,
      parentId: params.requestBody.parents?.[0] ?? "root",
      mimeType: params.requestBody.mimeType ?? "application/octet-stream",
      modifiedTime: new Date().toISOString(),
      ...(params.media ? { bytes: await drain(params.media.body) } : {}),
    };
    this.nodes.set(id, node);
    return {
      data: { id, name: node.name, size: node.bytes ? String(node.bytes.byteLength) : undefined },
    };
  }

  async update(params: { fileId: string; media?: { body: unknown } }) {
    const node = this.nodes.get(params.fileId);
    if (!node) throw driveNotFound();
    if (params.media) node.bytes = await drain(params.media.body);
    node.modifiedTime = new Date().toISOString();
    return {
      data: { id: params.fileId, size: node.bytes ? String(node.bytes.byteLength) : undefined },
    };
  }

  get(params: { fileId: string; alt?: string }, opts?: { responseType?: string }) {
    const node = this.nodes.get(params.fileId);
    if (!node) throw driveNotFound();
    if (params.alt === "media") {
      const bytes = node.bytes ?? new Uint8Array();
      if (opts?.responseType === "stream") {
        return Promise.resolve({ data: Readable.from(Buffer.from(bytes)) });
      }
      return Promise.resolve({ data: bytes.slice().buffer });
    }
    return Promise.resolve({
      data: {
        id: params.fileId,
        name: node.name,
        mimeType: node.mimeType,
        size: node.bytes ? String(node.bytes.byteLength) : "0",
        modifiedTime: node.modifiedTime,
        md5Checksum: "md5",
      },
    });
  }

  delete(params: { fileId: string }) {
    if (!this.nodes.has(params.fileId)) throw driveNotFound();
    this.deleteRecursive(params.fileId);
    return Promise.resolve({ data: {} });
  }

  export(params: { fileId: string; mimeType: string }) {
    const node = this.nodes.get(params.fileId);
    if (!node) throw driveNotFound();
    return Promise.resolve({
      data: new TextEncoder().encode(`exported:${node.name}:${params.mimeType}`).slice().buffer,
    });
  }

  private deleteRecursive(id: string): void {
    this.nodes.delete(id);
    for (const [childId, node] of [...this.nodes]) {
      if (node.parentId === id) this.deleteRecursive(childId);
    }
  }
}

class FakeDrive {
  readonly files = new FakeFiles();
}

function fakeDrive(): drive_v3.Drive {
  return new FakeDrive() as unknown as drive_v3.Drive;
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

void FOLDER_MIME;

// The linchpin: the Google Drive driver (ID-native + resolver) must satisfy the contract.
describeConformance("GoogleDrive (fake)", () => new GoogleDriveDriver({ drive: fakeDrive() }));

describe("GoogleDriveDriver specifics", () => {
  it("is Node-only and exposes the injected Drive client as native", () => {
    const drive = fakeDrive();
    const driver = new GoogleDriveDriver({ drive });
    expect(driver.environments.has("node")).toBe(true);
    expect(driver.environments.has("browser")).toBe(false);
    expect(driver.native).toBe(drive);
  });

  it("auto-creates intermediate folders on a nested put (resolve-or-create)", async () => {
    const driver = new GoogleDriveDriver({ drive: fakeDrive() });
    await driver.put("x/y/z.txt", "deep");
    expect(await driver.exists("x/y/z.txt")).toBe(true);
    const files = (await collect(driver.list("x", { recursive: true })))
      .filter((e) => e.type === "file")
      .map((e) => e.path);
    expect(files).toEqual(["x/y/z.txt"]);
  });

  it("throws AlreadyExistsError when overwrite is false", async () => {
    const storage = createStorage(new GoogleDriveDriver({ drive: fakeDrive() }));
    await storage.put("once.txt", "first");
    await expect(
      storage.unwrap().put("once.txt", "second", { overwrite: false }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("exports native-doc bytes via the Layer-1 export() method", async () => {
    const driver = new GoogleDriveDriver({ drive: fakeDrive() });
    await driver.put("doc.txt", "ignored");
    const bytes = await driver.export("doc.txt", "text/plain");
    expect(new TextDecoder().decode(bytes)).toContain("doc.txt");
  });

  it("requires drive or auth", () => {
    expect(() => new GoogleDriveDriver({})).toThrow();
  });
});

const LIVE = process.env.GENERA_GDRIVE_TEST === "1";
if (!LIVE) {
  describe.skip("GoogleDrive (live — needs a configured drive client; out of scope here)", () => {
    it("skipped", () => {});
  });
}
