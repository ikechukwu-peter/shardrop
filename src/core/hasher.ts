// SHA-256 as lowercase hex
import type { HashRequest, HashResponse } from "./hash-worker";

export async function hashChunk(data: Blob): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", await data.arrayBuffer());
  return toHex(hash);
}

/**
 * Utility function to compute a SHA-256 hash from a plain text string
 */
export async function computeStringSHA256(text: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);

  // Convert the binary buffer into a hex string
  return toHex(hashBuffer);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A small pool of hashing workers, created on first use.
 *
 * Hashing is the only CPU-bound work in a transfer, and it happens once per
 * chunk on both sides. Off the main thread, a 5 GB file no longer freezes the
 * page while its manifest is built.
 */
class HashPool {
  private readonly workers: Worker[] = [];
  private readonly pending = new Map<
    number,
    { resolve: (hash: string) => void; reject: (error: Error) => void }
  >();
  private nextId = 1;
  private cursor = 0;

  constructor(size: number) {
    for (let index = 0; index < size; index++) {
      const worker = new Worker(new URL("./hash-worker.ts", import.meta.url), {
        type: "module",
      });
      worker.addEventListener(
        "message",
        (event: MessageEvent<HashResponse>) => {
          const waiting = this.pending.get(event.data.id);
          if (!waiting) return;
          this.pending.delete(event.data.id);
          if ("hash" in event.data) waiting.resolve(event.data.hash);
          else waiting.reject(new Error(event.data.error));
        },
      );
      this.workers.push(worker);
    }
  }

  hash(buffer: ArrayBuffer): Promise<string> {
    const id = this.nextId++;
    // Round robin: every chunk is the same size, so nothing cleverer pays off.
    const worker = this.workers[this.cursor++ % this.workers.length]!;
    return new Promise<string>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, buffer } satisfies HashRequest, [buffer]);
    });
  }
}

let pool: HashPool | null = null;

function workerPool(): HashPool | null {
  if (typeof Worker === "undefined") return null; // tests, and older browsers
  if (!pool) {
    const cores = globalThis.navigator?.hardwareConcurrency ?? 2;
    pool = new HashPool(Math.max(1, Math.min(4, cores - 1)));
  }
  return pool;
}

/**
 * Hashes a chunk in a worker where one is available, on this thread otherwise.
 * The result is identical either way; only who blocks differs.
 */
export async function hashChunkOffThread(data: Blob): Promise<string> {
  const workers = workerPool();
  if (!workers) return hashChunk(data);
  try {
    return await workers.hash(await data.arrayBuffer());
  } catch {
    return hashChunk(data); // a broken worker must not fail the transfer
  }
}
