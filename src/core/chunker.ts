// Core logic lives in src/core and must not touch the DOM (Rule 8: the UI is not responsible for correctness).

export type FileChunk = {
  index: number;
  offset: number;
  size: number;
  data: Blob;
};

export type ChunkMetadata = {
  index: number;
  size: number;
  hash: string;
};

/**
 * Milestone 2: split a file into chunks lazily, without reading it into memory.
 */
export function chunkFile(file: Blob, chunkSize: number) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive integer");
  }

  return (function* (): Generator<FileChunk> {
    let index = 0;

    for (let offset = 0; offset < file.size; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, file.size);

      yield {
        index,
        offset,
        size: end - offset,
        data: file.slice(offset, end),
      };

      index++;
    }
  })();
}
