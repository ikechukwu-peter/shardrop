import { describe, expect, it } from "vitest";
import { MemoryChunkStore } from "./chunk-store";
import { createFileManifest } from "./manifest";
import type { FileManifest } from "./manifest";

const CHUNK_SIZE = 4;

async function manifestFor(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<FileManifest> {
  return createFileManifest(
    new File([bytes], "demo.bin", { type: "application/octet-stream" }),
    CHUNK_SIZE,
  );
}

describe("MemoryChunkStore", () => {
  const source = new Uint8Array(10).map((_, i) => i + 1);
  const chunkAt = (index: number) =>
    source.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE);

  it("reports every chunk missing before anything arrives", async () => {
    const store = new MemoryChunkStore(await manifestFor(source));
    expect(store.missing()).toEqual([0, 1, 2]);
    expect(store.received()).toEqual([]);
  });

  it("tracks which chunks have arrived, in any order", async () => {
    const store = new MemoryChunkStore(await manifestFor(source));

    await store.write(2, chunkAt(2));
    await store.write(0, chunkAt(0));

    expect(store.has(2)).toBe(true);
    expect(store.has(1)).toBe(false);
    expect(store.missing()).toEqual([1]);
    expect(store.received()).toEqual([0, 2]);
  });

  it("refuses to finalize while chunks are missing", async () => {
    const store = new MemoryChunkStore(await manifestFor(source));
    await store.write(0, chunkAt(0));
    await expect(store.finalize()).rejects.toThrow("still missing");
  });

  it("rebuilds the original bytes once every chunk has arrived", async () => {
    const manifest = await manifestFor(source);
    const store = new MemoryChunkStore(manifest);

    for (const index of [1, 2, 0]) await store.write(index, chunkAt(index));

    const file = await store.finalize();
    expect(file.name).toBe("demo.bin");
    expect(file.size).toBe(source.byteLength);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(source);
  });

  it("rejects a chunk index outside the manifest", async () => {
    const store = new MemoryChunkStore(await manifestFor(source));
    await expect(store.write(3, chunkAt(0))).rejects.toThrow("outside");
    await expect(store.write(-1, chunkAt(0))).rejects.toThrow("outside");
  });

  it("copies incoming bytes so a reused buffer cannot corrupt the file", async () => {
    const manifest = await manifestFor(source);
    const store = new MemoryChunkStore(manifest);

    // The sender may reuse one scratch buffer for every chunk.
    const scratch = new Uint8Array(CHUNK_SIZE);
    for (let index = 0; index < manifest.totalChunks; index++) {
      scratch.fill(0);
      scratch.set(chunkAt(index));
      await store.write(index, scratch.subarray(0, chunkAt(index).length));
    }

    expect(
      new Uint8Array(await (await store.finalize()).arrayBuffer()),
    ).toEqual(source);
  });

  it("forgets everything after discard", async () => {
    const store = new MemoryChunkStore(await manifestFor(source));
    await store.write(0, chunkAt(0));
    await store.discard();
    expect(store.received()).toEqual([]);
  });
});
