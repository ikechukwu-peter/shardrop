import { chunkFile, type ChunkMetadata } from "./chunker";
import { computeStringSHA256, hashChunkOffThread } from "./hasher";

export type FileManifest = {
  transferId: string;
  fileId: string;
  name: string;
  /** Path within a chosen folder, or just the name for a single file. */
  path: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  chunks: ChunkMetadata[];
};

/**
 * Paths for files that came from a dropped folder. Those arrive without a
 * webkitRelativePath, which is read-only, so their path is recorded here
 * instead. Weak, so a file that is no longer referenced takes its path with it.
 */
const relativePaths = new WeakMap<File, string>();

export function setRelativePath(file: File, path: string): void {
  relativePaths.set(file, path);
}

/** Where a file sat inside a chosen or dropped folder, or just its name. */
export function relativePath(file: File): string {
  return relativePaths.get(file) || file.webkitRelativePath || file.name;
}

export async function createFileManifest(
  file: File,
  chunkSize: number,
): Promise<FileManifest> {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }
  const chunkObjects: ChunkMetadata[] = [];
  const allChunkHashes: string[] = [];
  let totalChunks = 0;

  for (const chunk of chunkFile(file, chunkSize)) {
    const chunkHash = await hashChunkOffThread(chunk.data);
    chunkObjects.push({
      index: chunk.index,
      size: chunk.size,
      hash: chunkHash,
    });
    allChunkHashes.push(chunkHash);
    totalChunks++;
  }

  return {
    transferId: crypto.randomUUID(),
    fileId: await computeStringSHA256(
      chunkSize + "\n" + allChunkHashes.join(""),
    ),
    name: file.name,
    path: relativePath(file),
    size: file.size,
    mimeType: file.type,
    chunkSize,
    totalChunks,
    chunks: chunkObjects,
  };
}
