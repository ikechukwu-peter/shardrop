import { describe, expect, it } from "vitest";
import { computeStringSHA256, hashChunk } from "./hasher";

describe("hashChunk", () => {
  it("returns the correct hash for a small file", async () => {
    const file = new Blob([new Uint8Array(10)]);
    const hash = await hashChunk(file);
    expect(hash).toBe(
      "01d448afd928065458cf670b60f5a594d735af0172c8d67f22a81680132681ca",
    );
  });
  it("returns the correct hash for a large file", async () => {
    const file = new Blob([new Uint8Array(1000000)]);
    const hash = await hashChunk(file);
    expect(hash).toBe(
      "d29751f2649b32ff572b5e0a9f541ea660a50f94ff0beedfb0b692b924cc8025",
    );
  });

  it("an empty blob still hashes", async () => {
    const file = new Blob([]);
    const hash = await hashChunk(file);
    expect(hash).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("it is always 64 characters long", async () => {
    const file = new Blob([new Uint8Array(10)]);
    const hash = await hashChunk(file);
    expect(hash.length).toBe(64);
  });

  it("the same input always give the same hash back", async () => {
    const file = new Blob([new Uint8Array(10)]);
    const hash1 = await hashChunk(file);
    const hash2 = await hashChunk(file);
    expect(hash1).toBe(hash2);
  });
  it(" two different inputs give different hashes", async () => {
    const file1 = new Blob([new Uint8Array(10)]);
    const file2 = new Blob([new Uint8Array(12)]);
    const hash1 = await hashChunk(file1);
    const hash2 = await hashChunk(file2);
    expect(hash1).not.toBe(hash2);
  });
});

describe("computeStringSHA256 & createFileManifest ID generation", () => {
  it("computeStringSHA256 returns correct hash for standard text strings", async () => {
    // SHA-256 for "hello world"
    const hash = await computeStringSHA256("hello world");
    expect(hash).toBe(
      "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
  });
});
