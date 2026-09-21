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
    // webkitRelativePath is set when the file came from a folder picker.
    path: file.webkitRelativePath || file.name,
    size: file.size,
    mimeType: file.type,
    chunkSize,
    totalChunks,
    chunks: chunkObjects,
  };
}
