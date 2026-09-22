# 005 — Hashing in a worker, on the evidence

## Context

Hashing is the only CPU-bound work in a transfer: every shard is hashed once by the sender when the manifest is built, and once by the receiver on arrival. The original plan (idea.md milestone 15) assumed this would have to move to a Web Worker to keep the page responsive. The rule was to measure rather than guess (rule 12).

## What was measured

A 200 MB file, chunked and hashed in Chromium, on the main thread and in a pool of workers. "Longest stall" is the largest gap between animation frames, which is what a person perceives as a freeze. Full numbers in [benchmarks.md](../benchmarks.md).

| Shard size | Main thread            | Worker                 |
| ---------- | ---------------------- | ---------------------- |
| 256 KB     | 702 MB/s, 17 ms stall  | 602 MB/s, 17 ms stall  |
| 1 MB       | 869 MB/s, 19 ms stall  | 872 MB/s, 17 ms stall  |
| 5 MB       | 1062 MB/s, 20 ms stall | 1104 MB/s, 17 ms stall |

A single 50 MB digest, separately:

| Hashed on   | Longest stall |
| ----------- | ------------- |
| main thread | 66 ms         |
| worker      | 25 ms         |

The frame watcher was validated against a deliberately blocking 300 ms loop, which it reported as 300.1 ms. Without that control the first version of this experiment reported 0 ms for everything, because a stall is only visible on the frame _after_ it: the measurement was wrong, not the result.

## Decision

Hash in a worker pool, falling back to this thread where `Worker` is unavailable.

The honest reading of the numbers:

- **Throughput is unaffected.** At 600–1100 MB/s, hashing is not the bottleneck; the DataChannel is. `crypto.subtle.digest` is genuinely asynchronous in Chromium and already does most of its work off the calling thread, which is why the two columns match.
- **At realistic shard sizes the worker wins nothing measurable.** 17 ms versus 19 ms is frame pacing, not a difference.
- **At large sizes it does.** One 50 MB digest stalls the page for 66 ms on the main thread — four frames dropped — against 25 ms in a worker. Shards can be 25 MB, and a browser without an off-thread `digest` would be worse still.

So the worker stays: it costs nothing, it removes the worst case, and it protects against engines whose `digest` is not off-thread. It is not, as the original plan assumed, what makes large transfers feasible — chunking and backpressure do that.

## Consequences

- Buffers are transferred to the worker rather than copied, so a chunk crosses once.
- The pool is `min(4, cores - 1)` workers, created on first use. Round robin, because every chunk is the same size.
- A worker that fails falls back to hashing on this thread: a broken worker must never fail a transfer.
- `hashChunk` remains for tests and for the fallback path, so the unit tests need no worker.
- Worth revisiting on mobile, where cores are slower and `digest` may not be off-thread. The benchmark is a Playwright test, so it can be re-run anywhere.
