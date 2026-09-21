# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |
| --- | --- | --- | --- | --- |
| 256 KB | main thread | 599.2 MB/s | 0.33s | 17.6 ms |
| 256 KB | worker | 638.6 MB/s | 0.31s | 17.5 ms |
| 1 MB | main thread | 880.7 MB/s | 0.23s | 19.2 ms |
| 1 MB | worker | 855.1 MB/s | 0.23s | 17.5 ms |
| 5 MB | main thread | 943.8 MB/s | 0.21s | 21.6 ms |
| 5 MB | worker | 1032.5 MB/s | 0.19s | 18.9 ms |

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
| main thread | 50.8 ms |
| worker | 17.5 ms |

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **300.1 ms**, so the watcher does detect a blocked thread.

Reproduce with `npx playwright test e2e/benchmark.spec.ts`.
