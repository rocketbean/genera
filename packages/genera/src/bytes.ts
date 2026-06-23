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

/**
 * Yield `data` as fixed-size chunks. A `Uint8Array` is sliced into views; a
 * `ReadableStream` is read incrementally and re-chunked to `chunkSize` without
 * ever buffering the whole payload. Powers the chunked/session upload paths of the
 * Tier 2 drivers. The final chunk may be smaller than `chunkSize`.
 */
export async function* chunkBytes(
  data: Uint8Array | ReadableStream<Uint8Array>,
  chunkSize: number,
): AsyncIterable<Uint8Array> {
  if (data instanceof Uint8Array) {
    for (let offset = 0; offset < data.byteLength; offset += chunkSize) {
      yield data.subarray(offset, Math.min(offset + chunkSize, data.byteLength));
    }
    return;
  }

  const reader = data.getReader();
  let buffer = new Uint8Array(0);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const merged = new Uint8Array(buffer.byteLength + value.byteLength);
      merged.set(buffer, 0);
      merged.set(value, buffer.byteLength);
      buffer = merged;
      while (buffer.byteLength >= chunkSize) {
        yield buffer.subarray(0, chunkSize);
        buffer = buffer.slice(chunkSize);
      }
    }
  } finally {
    reader.releaseLock();
  }
  if (buffer.byteLength > 0) yield buffer;
}
