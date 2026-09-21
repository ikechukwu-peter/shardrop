# Benchmarks

Chunking and SHA-256 hashing of a 200 MB file, measured in Chromium on the
machine that ran the suite. "Longest stall" is the largest gap between
animation frames during the run: what a person experiences as the page
freezing.

| Shard size | Hashed on | Throughput | 200 MB in | Longest stall |
| --- | --- | --- | --- | --- |
| 256 KB | main thread | 777 MB/s | 0.26s | 18.1 ms |
| 256 KB | worker | 709.5 MB/s | 0.28s | 17.3 ms |
| 1 MB | main thread | 947.4 MB/s | 0.21s | 18.6 ms |
| 1 MB | worker | 872.6 MB/s | 0.23s | 17.4 ms |
| 5 MB | main thread | 1029.9 MB/s | 0.19s | 19.4 ms |
| 5 MB | worker | 1129.9 MB/s | 0.18s | 17.4 ms |

## Does hashing block the page?

One 50 MB digest, with the same frame watcher:

| Hashed on | Longest stall |
| --- | --- |
| main thread | 55.3 ms |
| worker | 16.9 ms |

As a control, a deliberately blocking 300 ms loop on the main thread stalls
frames for **300.1 ms**, so the watcher does detect a blocked thread.

Reproduce with `npx playwright test e2e/benchmark.spec.ts`.
