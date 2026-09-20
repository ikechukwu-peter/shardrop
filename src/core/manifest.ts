import { chunkFile, type ChunkMetadata } from "./chunker";
import { computeStringSHA256, hashChunk } from "./hasher";

export type FileManifest = {
  transferId: string;
  fileId: string;
  name: string;
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
    const chunkHash = await hashChunk(chunk.data);
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
    size: file.size,
    mimeType: file.type,
    chunkSize,
    totalChunks,
    chunks: chunkObjects,
  };
}
