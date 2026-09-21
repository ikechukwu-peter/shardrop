# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |
| --- | --- | --- | --- | --- |
| 256 KB | main thread | 715.3 MB/s | 0.28s | 17.3 ms |
| 256 KB | worker | 700.3 MB/s | 0.29s | 16.9 ms |
| 1 MB | main thread | 964.3 MB/s | 0.21s | 17 ms |
| 1 MB | worker | 763.4 MB/s | 0.26s | 17.6 ms |
| 5 MB | main thread | 794.6 MB/s | 0.25s | 20.1 ms |
| 5 MB | worker | 600.2 MB/s | 0.33s | 17.1 ms |

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
| main thread | 75.1 ms |
| worker | 24.6 ms |

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **300.1 ms**, so the watcher does detect a blocked thread.

Reproduce with `npx playwright test e2e/benchmark.spec.ts`.
