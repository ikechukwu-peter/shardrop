/**
 * Where received chunks live until the file is complete.
 *
 * OPFS (the Origin Private File System) is used rather than IndexedDB because
 * each chunk can be written straight to its own position in a real file, so
 * memory stays flat and finishing costs nothing. See docs/decisions/002-opfs.md.
 *
 * Progress is persisted next to the data, so a transfer survives a reload:
 * which chunks arrived is the only state resume needs.
 */
import type { FileManifest } from "./manifest";

export interface ChunkStore {
  /** Stores one verified chunk at its offset. */
  write(chunkIndex: number, bytes: Uint8Array): Promise<void>;
  has(chunkIndex: number): boolean;
  /** Indexes still missing, in ascending order. */
  missing(): number[];
  received(): number[];
  /** Assembles the finished file. Throws while anything is still missing. */
  finalize(): Promise<File>;
  /** Removes the partial file and its state. */
  discard(): Promise<void>;
}

type StoredState = {
  manifest: FileManifest;
  received: number[];
  updatedAt: number;
  complete: boolean;
  completedAt?: number;
};

/** Whether a file of this size can be stored, decided before accepting it. */
export type QuotaVerdict = {
  ok: boolean;
  needed: number;
  available?: number;
  reason?: string;
};

/** Room to spare: the browser also needs space for the assembled copy. */
const QUOTA_HEADROOM = 1.15;

/** Pure, so the arithmetic is testable without a storage backend. */
export function quotaVerdict(
  needed: number,
  quota?: number,
  usage?: number,
): QuotaVerdict {
  if (quota === undefined) return { ok: true, needed }; // nothing to go on
  const available = Math.max(0, quota - (usage ?? 0));
  if (needed * QUOTA_HEADROOM <= available)
    return { ok: true, needed, available };
  return {
    ok: false,
    needed,
    available,
    reason: `needs ${formatSize(needed)} of storage but only ${formatSize(available)} is available`,
  };
}

/** Asks the browser for its quota, and for the storage to be kept. */
export async function checkQuota(needed: number): Promise<QuotaVerdict> {
  if (typeof navigator?.storage?.estimate !== "function") {
    return { ok: true, needed };
  }
  try {
    // Persisted storage is not evicted under pressure mid-transfer.
    await navigator.storage.persist?.();
    const { quota, usage } = await navigator.storage.estimate();
    return quotaVerdict(needed, quota, usage);
  } catch {
    return { ok: true, needed };
  }
}

function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent =
    bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = Math.min(exponent, units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

const PART_SUFFIX = ".part";
const STATE_SUFFIX = ".state.json";

/** In-memory store: used by tests and as a fallback where OPFS is missing. */
export class MemoryChunkStore implements ChunkStore {
  private readonly parts = new Map<number, Uint8Array>();

  constructor(private readonly manifest: FileManifest) {}

  // Async so a bad index rejects rather than throwing synchronously: callers
  // handle one failure path, not two.
  async write(chunkIndex: number, bytes: Uint8Array): Promise<void> {
    assertKnownChunk(this.manifest, chunkIndex);
    this.parts.set(chunkIndex, copyOf(bytes));
  }

  has(chunkIndex: number): boolean {
    return this.parts.has(chunkIndex);
  }

  missing(): number[] {
    return missingIndexes(this.manifest, (i) => this.parts.has(i));
  }

  received(): number[] {
    return [...this.parts.keys()].sort((a, b) => a - b);
  }

  async finalize(): Promise<File> {
    assertComplete(this.missing());
    const ordered = this.received().map((index) => this.parts.get(index)!);
    return new File(ordered as BlobPart[], this.manifest.name, {
      type: this.manifest.mimeType,
    });
  }

  async discard(): Promise<void> {
    this.parts.clear();
  }
}

/** OPFS-backed store: one sparse file per transfer, written at offsets. */
export class OpfsChunkStore implements ChunkStore {
  /**
   * Writes run one at a time. Several chunks are in flight at once, and two
   * overlapping writables on one file handle either throw or clobber each
   * other: each one starts from a snapshot of the file, so the last close
   * wins and the other chunk is silently lost.
   */
  private writes: Promise<void> = Promise.resolve();

  private constructor(
    private readonly manifest: FileManifest,
    private readonly dir: FileSystemDirectoryHandle,
    private readonly part: FileSystemFileHandle,
    private readonly receivedSet: Set<number>,
  ) {}

  /** Opens the store for a manifest, reusing an interrupted transfer's chunks. */
  static async open(manifest: FileManifest): Promise<OpfsChunkStore> {
    const dir = await navigator.storage.getDirectory();
    const part = await dir.getFileHandle(manifest.fileId + PART_SUFFIX, {
      create: true,
    });
    const received = await readState(dir, manifest);
    // Someone else's abandoned transfer should not fill the quota forever.
    await sweep(dir, manifest.fileId);
    return new OpfsChunkStore(manifest, dir, part, received);
  }

  write(chunkIndex: number, bytes: Uint8Array): Promise<void> {
    assertKnownChunk(this.manifest, chunkIndex);
    const data = copyOf(bytes);

    this.writes = this.writes.then(async () => {
      // keepExistingData keeps the chunks already written; position seeks to
      // this chunk's offset, so chunks may arrive in any order.
      const writable = await this.part.createWritable({
        keepExistingData: true,
      });
      await writable.write({
        type: "write",
        position: chunkIndex * this.manifest.chunkSize,
        data: data.buffer,
      });
      await writable.close();

      this.receivedSet.add(chunkIndex);
      await this.persistState();
    });

    return this.writes;
  }

  has(chunkIndex: number): boolean {
    return this.receivedSet.has(chunkIndex);
  }

  missing(): number[] {
    return missingIndexes(this.manifest, (i) => this.receivedSet.has(i));
  }

  received(): number[] {
    return [...this.receivedSet].sort((a, b) => a - b);
  }

  async finalize(): Promise<File> {
    await this.writes; // never assemble while a chunk is still being written
    assertComplete(this.missing());
    await this.persistState(); // marks it complete, so the sweep can clear it
    const file = await this.part.getFile();
    // The last write may have padded the file; trim to the manifest's size.
    return new File([file.slice(0, this.manifest.size)], this.manifest.name, {
      type: this.manifest.mimeType,
    });
  }

  async discard(): Promise<void> {
    this.receivedSet.clear();
    await this.dir.removeEntry(this.manifest.fileId + PART_SUFFIX).catch(noop);
    await this.dir.removeEntry(this.manifest.fileId + STATE_SUFFIX).catch(noop);
  }

  private async persistState(): Promise<void> {
    const handle = await this.dir.getFileHandle(
      this.manifest.fileId + STATE_SUFFIX,
      { create: true },
    );
    const writable = await handle.createWritable();
    const complete = this.missing().length === 0;
    const state: StoredState = {
      manifest: this.manifest,
      received: this.received(),
      updatedAt: Date.now(),
      complete,
      ...(complete ? { completedAt: Date.now() } : {}),
    };
    await writable.write(JSON.stringify(state));
    await writable.close();
  }
}

/** Picks OPFS when the browser has it, memory otherwise. */
export async function createChunkStore(
  manifest: FileManifest,
): Promise<ChunkStore> {
  if (typeof navigator?.storage?.getDirectory === "function") {
    try {
      return await OpfsChunkStore.open(manifest);
    } catch {
      // Private windows and some embedded browsers refuse OPFS.
    }
  }
  return new MemoryChunkStore(manifest);
}

/** How long a partial transfer is kept before its shards are discarded. */
const PART_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * A finished transfer is kept for a while: the File handed to the page reads
 * straight from this OPFS file, so deleting it early breaks the download the
 * user has not clicked yet.
 */
const COMPLETE_TTL_MS = 60 * 60 * 1000;

/**
 * Deletes finished or stale leftovers. A cancelled or crashed transfer would
 * otherwise keep its shards in OPFS forever, and the user never sees them.
 */
async function sweep(
  dir: FileSystemDirectoryHandle,
  keepFileId: string,
): Promise<void> {
  try {
    const stale: string[] = [];
    for await (const [name, handle] of dir.entries()) {
      if (!name.endsWith(STATE_SUFFIX)) continue;
      const fileId = name.slice(0, -STATE_SUFFIX.length);
      if (fileId === keepFileId) continue;

      const state = JSON.parse(
        await (await (handle as FileSystemFileHandle).getFile()).text(),
      ) as StoredState;
      const now = Date.now();
      const expired = state.complete
        ? now - (state.completedAt ?? state.updatedAt ?? 0) > COMPLETE_TTL_MS
        : now - (state.updatedAt ?? 0) > PART_TTL_MS;
      if (expired) stale.push(fileId);
    }

    for (const fileId of stale) {
      await dir.removeEntry(fileId + PART_SUFFIX).catch(noop);
      await dir.removeEntry(fileId + STATE_SUFFIX).catch(noop);
    }
  } catch {
    // Sweeping is housekeeping: never fail a transfer over it.
  }
}

async function readState(
  dir: FileSystemDirectoryHandle,
  manifest: FileManifest,
): Promise<Set<number>> {
  try {
    const handle = await dir.getFileHandle(manifest.fileId + STATE_SUFFIX);
    const text = await (await handle.getFile()).text();
    const state = JSON.parse(text) as StoredState;
    // A different chunking of the same content cannot reuse these chunks.
    if (state.manifest.chunkSize !== manifest.chunkSize) return new Set();
    return new Set(state.received);
  } catch {
    return new Set();
  }
}

function missingIndexes(
  manifest: FileManifest,
  have: (index: number) => boolean,
): number[] {
  const gaps: number[] = [];
  for (let index = 0; index < manifest.totalChunks; index++) {
    if (!have(index)) gaps.push(index);
  }
  return gaps;
}

function assertKnownChunk(manifest: FileManifest, chunkIndex: number): void {
  if (
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    chunkIndex >= manifest.totalChunks
  ) {
    throw new Error(
      `chunk ${chunkIndex} is outside this manifest (0..${manifest.totalChunks - 1})`,
    );
  }
}

function assertComplete(missing: number[]): void {
  if (missing.length > 0) {
    throw new Error(`cannot finalize: ${missing.length} chunks still missing`);
  }
}

/** Detaches from the caller's buffer, which may be reused for the next chunk. */
function copyOf(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
}

function noop(): void {}
