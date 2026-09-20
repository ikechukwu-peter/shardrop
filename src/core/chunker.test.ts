import { describe, expect, it, vi } from "vitest";
import { chunkFile } from "./chunker";

// Turn each `it.todo` into a real test before (or while) implementing chunkFile.
describe("chunkFile", () => {
  it("returns one chunk when the file is smaller than chunkSize", () => {
    const file = new Blob([new Uint8Array(3)]);
    const chunks = [...chunkFile(file, 4)];
    expect(chunks).toEqual([
      { index: 0, offset: 0, size: 3, data: new Blob([new Uint8Array(3)]) },
    ]);
    expect(chunks.length).toBe(1);
  });
  it("returns zero chunks for an empty file", () => {
    const file = new Blob([]);
    const chunks = [...chunkFile(file, 4)];
    expect(chunks).toEqual([]);
    expect(chunks.length).toBe(0);
  });
  it("returns exact chunks when size is a multiple of chunkSize", () => {
    const file = new Blob([new Uint8Array(12)]);
    const chunks = [...chunkFile(file, 4)];
    expect(chunks).toEqual([
      { index: 0, offset: 0, size: 4, data: new Blob([new Uint8Array(4)]) },
      { index: 1, offset: 4, size: 4, data: new Blob([new Uint8Array(4)]) },
      { index: 2, offset: 8, size: 4, data: new Blob([new Uint8Array(4)]) },
    ]);
    expect(chunks.length).toBe(3);
  });

  it("sets index and offset correctly on every chunk", () => {
    const file = new Blob([new Uint8Array(10)]);
    const chunks = [...chunkFile(file, 4)];
    expect(chunks).toEqual([
      { index: 0, offset: 0, size: 4, data: new Blob([new Uint8Array(4)]) },
      { index: 1, offset: 4, size: 4, data: new Blob([new Uint8Array(4)]) },
      { index: 2, offset: 8, size: 2, data: new Blob([new Uint8Array(2)]) },
    ]);
  });
  it("chunk sizes add up to the file size", () => {
    const file = new Blob([new Uint8Array(10)]);
    const total = [...chunkFile(file, 4)].reduce((sum, c) => sum + c.size, 0);
    expect(total).toBe(file.size);
  });
  it.each([
    [10, 4],
    [10, 10],
    [10, 3],
    [1, 100],
  ])(
    "chunk sizes add up to the file size (%i bytes, %i per chunk)",
    (size, chunkSize) => {
      const file = new Blob([new Uint8Array(size)]);
      const total = [...chunkFile(file, chunkSize)].reduce(
        (sum, c) => sum + c.size,
        0,
      );
      expect(total).toBe(file.size);
    },
  );

  // Example 1: comparing binary data. Vary the bytes so that chunks in the wrong
  // order or with the wrong offsets would fail, which a file of zeros would not catch.
  it("reassembling all chunks gives back identical bytes", async () => {
    const original = new Uint8Array(1000).map((_, i) => i % 256);
    const file = new Blob([original]);

    const rebuilt = new Blob([...chunkFile(file, 128)].map((c) => c.data));

    expect(rebuilt.size).toBe(file.size);
    expect(new Uint8Array(await rebuilt.arrayBuffer())).toEqual(original);
  });

  it("rejects chunkSize <= 0 or non-integer chunkSize", () => {
    expect(() => chunkFile(new Blob([new Uint8Array(10)]), 0)).toThrow(
      "chunkSize must be a positive integer",
    );
    expect(() => chunkFile(new Blob([new Uint8Array(10)]), 1.5)).toThrow(
      "chunkSize must be a positive integer",
    );

    expect(() => chunkFile(new Blob([new Uint8Array(10)]), -1)).toThrow(
      "chunkSize must be a positive integer",
    );

    expect(() => chunkFile(new Blob([new Uint8Array(10)]), NaN)).toThrow(
      "chunkSize must be a positive integer",
    );
  });

  // Example 2: proving laziness. Spy on file.slice() to count how often it is called:
  // creating the generator must call it zero times, and each chunk taken exactly once.
  it("does not slice until a chunk is consumed (lazy)", () => {
    const file = new Blob([new Uint8Array(1000)]);
    const slice = vi.spyOn(file, "slice");

    const chunks = chunkFile(file, 100);
    expect(slice).not.toHaveBeenCalled();

    chunks.next();
    expect(slice).toHaveBeenCalledTimes(1);
    expect(slice).toHaveBeenLastCalledWith(0, 100);

    chunks.next();
    expect(slice).toHaveBeenCalledTimes(2);
  });
});
