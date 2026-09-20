import { describe, expect, it } from "vitest";
import { chunkFile } from "../core/chunker";
import { hashChunk } from "../core/hasher";

describe("hasher", async () => {
  it("performance benchmark: hash 100 MB in 1 MB chunks", async () => {
    const ONE_MB = 1024 * 1024;
    const FILE_SIZE = 100 * ONE_MB;

    // 1. Create a 100 MB fake file in memory
    const file = new Blob([new Uint8Array(FILE_SIZE)]);

    // 2. Start the timer
    const startTime = performance.now();

    // 3. Stream the file through your generator and hash each chunk
    const chunks = chunkFile(file, ONE_MB);
    for (const chunk of chunks) {
      // hashChunk accepts a Blob; c.data from your chunker is a Blob slice
      await hashChunk(chunk.data);
    }

    // 4. Stop the timer
    const endTime = performance.now();
    const durationMs = endTime - startTime;

    // 5. Print out the raw metrics for your idea.md file
    console.log(
      `\n⏱️  BENCHMARK RESULT: Hashed 100MB in ${(durationMs / 1000).toFixed(2)}s (${durationMs.toFixed(0)} ms)`,
    );
    expect(durationMs).toBeLessThan(1000);
  });
});
