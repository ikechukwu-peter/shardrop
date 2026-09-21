# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |
| --- | --- | --- | --- | --- |
| 256 KB | main thread | 701.3 MB/s | 0.29s | 18.1 ms |
| 256 KB | worker | 687 MB/s | 0.29s | 18.5 ms |
| 1 MB | main thread | 981.4 MB/s | 0.2s | 17.8 ms |
| 1 MB | worker | 855.8 MB/s | 0.23s | 17.4 ms |
| 5 MB | main thread | 1112.3 MB/s | 0.18s | 19.1 ms |
| 5 MB | worker | 1090.5 MB/s | 0.18s | 18 ms |

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
| main thread | 63.9 ms |
| worker | 17.5 ms |

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **300.1 ms**, so the watcher does detect a blocked thread.

Reproduce with `npx playwright test e2e/benchmark.spec.ts`.
