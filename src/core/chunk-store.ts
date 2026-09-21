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
};

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
    return new OpfsChunkStore(manifest, dir, part, received);
  }

  async write(chunkIndex: number, bytes: Uint8Array): Promise<void> {
    assertKnownChunk(this.manifest, chunkIndex);

    // keepExistingData keeps the chunks already written; position seeks to this
    // chunk's offset, so chunks may arrive in any order.
    const writable = await this.part.createWritable({ keepExistingData: true });
    await writable.write({
      type: "write",
      position: chunkIndex * this.manifest.chunkSize,
      data: copyOf(bytes).buffer,
    });
    await writable.close();

    this.receivedSet.add(chunkIndex);
    await this.persistState();
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
    assertComplete(this.missing());
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
    const state: StoredState = {
      manifest: this.manifest,
      received: this.received(),
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
