/**
 * Measures in a real browser what happy-dom cannot: how fast chunking and
 * hashing actually are, and how much the main thread is blocked while it
 * happens. Run with: npx playwright test e2e/benchmark.spec.ts
 *
 * Numbers land in docs/benchmarks.md.
 */
import { writeFileSync } from "node:fs";
import { test } from "@playwright/test";

type Row = {
  chunkKB: number;
  where: "main thread" | "worker";
  seconds: number;
  mbPerSecond: number;
  longestStallMs: number;
};

test("chunking and hashing throughput", async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto("/");

  const rows = await page.evaluate(async () => {
    // Loaded through a variable, because these are URLs the dev server
    // serves rather than module paths TypeScript can resolve from this file.
    const load = (path: string) => import(/* @vite-ignore */ path);
    const { chunkFile } = (await load("/src/core/chunker.ts")) as {
      chunkFile: (file: Blob, size: number) => Iterable<{ data: Blob }>;
    };
    const { hashChunk, hashChunkOffThread } = (await load(
      "/src/core/hasher.ts",
    )) as {
      hashChunk: (data: Blob) => Promise<string>;
      hashChunkOffThread: (data: Blob) => Promise<string>;
    };

    const SIZE = 200 * 1024 * 1024;
    // One buffer of varied bytes, reused: allocating per run would dominate.
    const source = new Uint8Array(SIZE);
    for (let i = 0; i < SIZE; i += 4096) source[i] = i & 255;
    const file = new File([source], "benchmark.bin");

    /**
     * Longest gap between animation frames: what a user feels as a freeze.
     *
     * Stopping has to wait for one more frame, because the gap created by a
     * blocked thread is only measurable on the frame that follows it.
     */
    function watchFrames() {
      let last = performance.now();
      let worst = 0;
      let running = true;
      const tick = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        if (running) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      return async () => {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        running = false;
        return worst;
      };
    }

    // Does a single large digest block rendering? If crypto.subtle.digest ran
    // on the calling thread, a 50 MB digest would stall it for tens of ms.
    const blocking: { where: string; longestStallMs: number }[] = [];
    for (const where of ["main thread", "worker"]) {
      const big = new Blob([source.subarray(0, 50 * 1024 * 1024)]);
      const hash = where === "worker" ? hashChunkOffThread : hashChunk;
      const stopWatching = watchFrames();
      await hash(big);
      blocking.push({
        where,
        longestStallMs: Number((await stopWatching()).toFixed(1)),
      });
    }
    // A deliberately synchronous 300 ms loop, to prove the frame watcher can
    // see a blocked main thread at all.
    const stopControl = watchFrames();
    const until = performance.now() + 300;
    while (performance.now() < until) {
      /* busy */
    }
    const controlStall = Number((await stopControl()).toFixed(1));

    const results = [];
    for (const chunkKB of [256, 1024, 5120]) {
      for (const where of ["main thread", "worker"]) {
        const hash = where === "worker" ? hashChunkOffThread : hashChunk;
        const stopWatching = watchFrames();
        const started = performance.now();

        for (const chunk of chunkFile(file, chunkKB * 1024)) {
          await hash(chunk.data);
        }

        const seconds = (performance.now() - started) / 1000;
        results.push({
          chunkKB,
          where,
          seconds: Number(seconds.toFixed(2)),
          mbPerSecond: Number((SIZE / 1024 / 1024 / seconds).toFixed(1)),
          longestStallMs: Number((await stopWatching()).toFixed(1)),
        });
      }
    }
    return { results, blocking, controlStall };
  });

  const { results, blocking, controlStall } = rows as {
    results: Row[];
    blocking: { where: string; longestStallMs: number }[];
    controlStall: number;
  };

  const table = [
    "| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |",
    "| --- | --- | --- | --- | --- |",
    ...results.map(
      (row) =>
        `| ${row.chunkKB >= 1024 ? `${row.chunkKB / 1024} MB` : `${row.chunkKB} KB`} | ${row.where} | ${row.mbPerSecond} MB/s | ${row.seconds}s | ${row.longestStallMs} ms |`,
    ),
  ].join("\n");

  writeFileSync(
    "docs/benchmarks.md",
    `# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

${table}

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
${blocking.map((row) => `| ${row.where} | ${row.longestStallMs} ms |`).join("\n")}

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **${controlStall} ms**, so the watcher does detect a blocked thread.

Reproduce with \`npx playwright test e2e/benchmark.spec.ts\`.
`,
  );
  console.log(table);
});
