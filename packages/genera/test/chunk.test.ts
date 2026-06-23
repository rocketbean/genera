import { describe, expect, it } from "vitest";

import { chunkBytes } from "../src/index";

async function collect(
  data: Uint8Array | ReadableStream<Uint8Array>,
  size: number,
): Promise<number[][]> {
  const out: number[][] = [];
  for await (const chunk of chunkBytes(data, size)) out.push([...chunk]);
  return out;
}

function streamOf(...parts: number[][]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const p of parts) controller.enqueue(new Uint8Array(p));
      controller.close();
    },
  });
}

describe("chunkBytes", () => {
  it("slices a Uint8Array into fixed-size chunks (last is the remainder)", async () => {
    expect(await collect(new Uint8Array([1, 2, 3, 4, 5, 6, 7]), 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7],
    ]);
  });

  it("yields a single chunk when the data is smaller than chunkSize", async () => {
    expect(await collect(new Uint8Array([1, 2]), 10)).toEqual([[1, 2]]);
  });

  it("yields nothing for empty data", async () => {
    expect(await collect(new Uint8Array([]), 4)).toEqual([]);
  });

  it("re-chunks a stream to chunkSize across reader boundaries", async () => {
    // Enqueues of 2 + 5 + 1 bytes, re-chunked to 3.
    const stream = streamOf([1, 2], [3, 4, 5, 6, 7], [8]);
    expect(await collect(stream, 3)).toEqual([
      [1, 2, 3],
      [4, 5, 6],
      [7, 8],
    ]);
  });

  it("reassembles to the original bytes", async () => {
    const original = Array.from({ length: 50 }, (_, i) => i % 256);
    const chunks = await collect(streamOf(original.slice(0, 13), original.slice(13)), 7);
    expect(chunks.flat()).toEqual(original);
  });
});
