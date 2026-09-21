# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |
| --- | --- | --- | --- | --- |
| 256 KB | main thread | 717.6 MB/s | 0.28s | 17.6 ms |
| 256 KB | worker | 697.6 MB/s | 0.29s | 17.6 ms |
| 1 MB | main thread | 909.5 MB/s | 0.22s | 18.3 ms |
| 1 MB | worker | 823.4 MB/s | 0.24s | 17.9 ms |
| 5 MB | main thread | 1038.4 MB/s | 0.19s | 18.6 ms |
| 5 MB | worker | 997.5 MB/s | 0.2s | 17.8 ms |

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
| main thread | 59.8 ms |
| worker | 20.1 ms |

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **300.1 ms**, so the watcher does detect a blocked thread.

Reproduce with `npx playwright test e2e/benchmark.spec.ts`.
