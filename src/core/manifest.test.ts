import { describe, expect, it } from "vitest";
import { createFileManifest } from "./manifest";

describe("manifest", () => {
  const file = new File(["test"], "test.txt", { type: "text/plain" });

  it("rejects chunkSize <= 0 or non-integer chunkSize", async () => {
    await expect(createFileManifest(file, 0)).rejects.toThrow(
      "chunkSize must be a positive integer",
    );
    await expect(createFileManifest(file, 1.5)).rejects.toThrow(
      "chunkSize must be a positive integer",
    );

    await expect(createFileManifest(file, -1)).rejects.toThrow(
      "chunkSize must be a positive integer",
    );

    await expect(createFileManifest(file, NaN)).rejects.toThrow(
      "chunkSize must be a positive integer",
    );
  });

  it("returns a manifest with the correct fields", async () => {
    const manifest = await createFileManifest(file, 2);
    expect(manifest.totalChunks).toBe(manifest.chunks.length);
    expect(manifest.chunks.map((c) => c.size).reduce((a, b) => a + b)).toBe(
      file.size,
    );
    expect(manifest.chunks[0]?.hash).toBe(
      "2d6c9a90dd38f6852515274cde41a8cd8e7e1a7a053835334ec7e29f61b918dd",
    );
  });

  it("createFileManifest produces a deterministic, repeatable file ID", async () => {
    const file = new File([new Uint8Array(100)], "test.txt", {
      type: "text/plain",
    });
    const chunkSize = 40;

    // Running manifest creation twice on identical setups must yield identical file IDs
    const manifest1 = await createFileManifest(file, chunkSize);
    const manifest2 = await createFileManifest(file, chunkSize);

    expect(manifest1.fileId).toBe(manifest2.fileId);
    expect(manifest1.fileId.length).toBe(64); // Confirms valid SHA-256 string length
  });

  it("changing the chunkSize completely alters the generated file ID", async () => {
    const file = new File([new Uint8Array(100)], "test.txt", {
      type: "text/plain",
    });

    // Same file payload, different slice setups
    const manifestWithSmallChunks = await createFileManifest(file, 20);
    const manifestWithLargeChunks = await createFileManifest(file, 50);

    // Verifies payload format template incorporates chunk size dependency safely
    expect(manifestWithSmallChunks.fileId).not.toBe(
      manifestWithLargeChunks.fileId,
    );
  });

  it("different content produces a different fileId", async () => {
    const file1 = new File([new Uint8Array([1, 2, 3])], "test.txt", {
      type: "text/plain",
    });
    const file2 = new File([new Uint8Array([1, 2, 99])], "test.txt", {
      type: "text/plain",
    }); // Changed the last byte
    const chunkSize = 2;

    const manifest1 = await createFileManifest(file1, chunkSize);
    const manifest2 = await createFileManifest(file2, chunkSize);

    expect(manifest1.fileId).not.toBe(manifest2.fileId);
  });

  it("the same content with a different chunk size produces a different fileId ", async () => {
    const file = new File([new Uint8Array(100)], "test.txt", {
      type: "text/plain",
    });

    // Identical content payload, completely different slice setups
    const manifestWithSmallChunks = await createFileManifest(file, 20);
    const manifestWithLargeChunks = await createFileManifest(file, 50);

    // Ensures chunk structure variance completely cascades into a unique fingerprint
    expect(manifestWithSmallChunks.fileId).not.toBe(
      manifestWithLargeChunks.fileId,
    );
  });
});
