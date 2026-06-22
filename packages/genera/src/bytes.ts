import type { PutData } from "./types";

/**
 * Convert any accepted `put()` input into a `Uint8Array`.
 * Uses only web-standard APIs (TextEncoder, Blob, ReadableStream), so it runs
 * unchanged in the browser and in Node 18+.
 */
export async function toBytes(data: PutData): Promise<Uint8Array> {
  if (typeof data === "string") {
    return new TextEncoder().encode(data);
  }
  if (data instanceof Uint8Array) {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  if (typeof ReadableStream !== "undefined" && data instanceof ReadableStream) {
    return drainStream(data);
  }
  throw new TypeError(
    "Unsupported data passed to put(): expected string | Uint8Array | ArrayBuffer | Blob | ReadableStream",
  );
}

async function drainStream(stream: ReadableStream): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk =
      value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
    chunks.push(chunk);
    total += chunk.byteLength;
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
