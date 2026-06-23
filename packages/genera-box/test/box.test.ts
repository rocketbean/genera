import { Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createStorage } from "@rocketbean/genera";
import { describeConformance } from "@rocketbean/genera/conformance";

import { BoxDriver, type BoxClient, type BoxItem } from "../src/index";

function boxNotFound(): Error {
  return Object.assign(new Error("Not Found"), { statusCode: 404 });
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
 * A stateful in-memory fake satisfying the structural `BoxClient` — an ID-native
 * tree rooted at folder `"0"`. Lets the full conformance kit + resolver behaviors
 * run offline.
 */
function createFakeBox(): BoxClient {
  const nodes = new Map<
    string,
    { name: string; parentId: string; type: "file" | "folder"; bytes?: Uint8Array }
  >();
  let seq = 0;
  const uploadSessions = new Map<
    string,
    { folderId: string; fileName: string; chunks: Uint8Array[] }
  >();
  const itemOf = (id: string): BoxItem => {
    const n = nodes.get(id)!;
    return {
      id,
      type: n.type,
      name: n.name,
      size: n.bytes ? n.bytes.byteLength : 0,
      modified_at: new Date().toISOString(),
      etag: "0",
    };
  };
  const deleteRecursive = (id: string): void => {
    nodes.delete(id);
    for (const [childId, n] of [...nodes]) if (n.parentId === id) deleteRecursive(childId);
  };

  return {
    folders: {
      getFolderItems(folderId) {
        const entries: BoxItem[] = [];
        for (const [id, n] of nodes) if (n.parentId === folderId) entries.push(itemOf(id));
        return Promise.resolve({ entries });
      },
      createFolder(body) {
        const id = `b${++seq}`;
        nodes.set(id, { name: body.name, parentId: body.parent.id, type: "folder" });
        return Promise.resolve(itemOf(id));
      },
      deleteFolderById(folderId) {
        if (!nodes.has(folderId)) throw boxNotFound();
        deleteRecursive(folderId);
        return Promise.resolve(undefined);
      },
    },
    files: {
      getFileById(fileId) {
        if (!nodes.has(fileId)) throw boxNotFound();
        return Promise.resolve(itemOf(fileId));
      },
      deleteFileById(fileId) {
        if (!nodes.has(fileId)) throw boxNotFound();
        nodes.delete(fileId);
        return Promise.resolve(undefined);
      },
    },
    uploads: {
      async uploadFile(body) {
        const id = `b${++seq}`;
        nodes.set(id, {
          name: body.attributes.name,
          parentId: body.attributes.parent.id,
          type: "file",
          bytes: await drain(body.file),
        });
        return { entries: [itemOf(id)] };
      },
      async uploadFileVersion(fileId, body) {
        const n = nodes.get(fileId);
        if (!n) throw boxNotFound();
        n.bytes = await drain(body.file);
        return { entries: [itemOf(fileId)] };
      },
    },
    downloads: {
      downloadFile(fileId) {
        const n = nodes.get(fileId);
        if (!n || n.type !== "file") throw boxNotFound();
        return Promise.resolve(Readable.from(Buffer.from(n.bytes ?? new Uint8Array())));
      },
    },
    chunkedUploads: {
      createFileUploadSession(body: { folderId: string; fileName: string; fileSize: number }) {
        const id = `up${++seq}`;
        uploadSessions.set(id, { folderId: body.folderId, fileName: body.fileName, chunks: [] });
        return Promise.resolve({ id, partSize: 5 });
      },
      uploadFilePart(uploadSessionId: string, requestBody: unknown) {
        const session = uploadSessions.get(uploadSessionId);
        const bytes = new Uint8Array(requestBody as Uint8Array);
        if (session) session.chunks.push(bytes);
        return Promise.resolve({ part: { size: bytes.byteLength } });
      },
      createFileUploadSessionCommit(uploadSessionId: string) {
        const session = uploadSessions.get(uploadSessionId)!;
        let total = 0;
        for (const c of session.chunks) total += c.byteLength;
        const bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of session.chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
        const id = `b${++seq}`;
        nodes.set(id, { name: session.fileName, parentId: session.folderId, type: "file", bytes });
        uploadSessions.delete(uploadSessionId);
        return Promise.resolve({ entries: [itemOf(id)] });
      },
    },
  };
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

// The linchpin: the Box driver (ID-native + resolver) must satisfy the contract.
describeConformance("Box (fake)", () => new BoxDriver({ client: createFakeBox() }));

describe("BoxDriver specifics", () => {
  it("is Node-only and exposes the injected client as native", () => {
    const client = createFakeBox();
    const driver = new BoxDriver({ client });
    expect(driver.environments.has("node")).toBe(true);
    expect(driver.environments.has("browser")).toBe(false);
    expect(driver.native).toBe(client);
  });

  it("auto-creates intermediate folders on a nested put (resolve-or-create)", async () => {
    const driver = new BoxDriver({ client: createFakeBox() });
    await driver.put("x/y/z.txt", "deep");
    expect(await driver.exists("x/y/z.txt")).toBe(true);
    const files = (await collect(driver.list("x", { recursive: true })))
      .filter((e) => e.type === "file")
      .map((e) => e.path);
    expect(files).toEqual(["x/y/z.txt"]);
  });

  it("is ID-native: resolveNativeId returns a stable Box id (cached)", async () => {
    const driver = new BoxDriver({ client: createFakeBox() });
    await driver.put("file.txt", "x");
    const id = await driver.resolveNativeId("file.txt");
    expect(id.length).toBeGreaterThan(0);
    expect(await driver.resolveNativeId("file.txt")).toBe(id);
  });

  it("throws AlreadyExistsError when overwrite is false", async () => {
    const storage = createStorage(new BoxDriver({ client: createFakeBox() }));
    await storage.put("once.txt", "first");
    await expect(
      storage.unwrap().put("once.txt", "second", { overwrite: false }),
    ).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  it("uploads a stream via a chunked upload session", async () => {
    const driver = new BoxDriver({ client: createFakeBox() });
    const payload = "box-chunked-upload-session-payload"; // multi-part at the fake's part size
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
