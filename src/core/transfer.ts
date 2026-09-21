/**
 * The transfer state machine: milestones 9-14.
 *
 * This is the heart of the project. Everything it needs already exists:
 *   chunkFile()      chunker.ts    — slice the file lazily
 *   hashChunk()      hasher.ts     — SHA-256 per chunk
 *   createFileManifest()           — what is being sent
 *   framesForChunk() frame.ts      — cut a chunk into sendable frames
 *   encodeControl()  protocol.ts   — MANIFEST / ACK / RETRY / …
 *   createChunkStore()             — OPFS-backed storage and resume state
 *
 * See docs/protocol.md for the message sequence and the rules.
 */
import type { PeerSession } from "./peer";
import type { FileManifest } from "./manifest";

export type TransferState =
  | "idle"
  | "negotiating"
  | "transferring"
  | "paused"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled";

export type TransferProgress = {
  state: TransferState;
  manifest?: FileManifest;
  chunksDone: number;
  chunksTotal: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  retries: number;
  /** Set when state is "failed". */
  error?: string;
};

export type ProgressListener = (progress: TransferProgress) => void;

export interface Transfer {
  onProgress(listener: ProgressListener): void;
  pause(): void;
  resume(): void;
  cancel(reason: string): void;
}

export interface SendTransfer extends Transfer {
  /** Builds the manifest, sends it, then streams chunks until COMPLETE. */
  start(): Promise<void>;
}

export interface ReceiveTransfer extends Transfer {
  /** Fires once every chunk has arrived and verified. */
  onComplete(listener: (file: File) => void): void;
}

export function createSendTransfer(
  _peer: PeerSession,
  _file: File,
  _chunkSize: number,
): SendTransfer {
  // TODO(Milestone 9-10): sender side.
  //
  // 1. Build the manifest, send MANIFEST, wait for READY.
  // 2. READY carries the chunks the receiver already has — skip those, which
  //    is all resume is on this side.
  // 3. For each remaining chunk: read it, cut it into frames (framePayloadLimit
  //    tells you how big), and send them.
  // 4. BACKPRESSURE, the part that matters: before each send, if
  //    channel.bufferedAmount > a high-water mark (~1 MB is a reasonable
  //    start), stop and wait for the "bufferedamountlow" event. Set
  //    channel.bufferedAmountLowThreshold once, up front. Sending without
  //    this either stalls the connection or kills the tab on a large file.
  // 5. Keep a window of unacknowledged chunks rather than waiting for each ACK
  //    (idea.md section 42.2 — look up bandwidth-delay product).
  // 6. On RETRY, resend that chunk. Give up after N attempts and fail loudly.
  // 7. When every chunk is acknowledged, send COMPLETE.
  throw new Error("Not implemented");
}

export function createReceiveTransfer(_peer: PeerSession): ReceiveTransfer {
  // TODO(Milestone 11-14): receiver side.
  //
  // 1. On MANIFEST: open a chunk store (createChunkStore), then reply READY
  //    with store.received() so an interrupted transfer picks up where it
  //    stopped.
  // 2. Collect frames per chunk until the chunk's bytes are complete (the
  //    manifest gives each chunk's size).
  // 3. Hash the assembled chunk and compare with the manifest's hash.
  //    Match   → store.write(index, bytes), then ACK.
  //    Mismatch→ RETRY with a reason, and do not store it.
  // 4. On COMPLETE: if anything is still missing, ask for it; otherwise
  //    finalize the store, send VERIFIED and hand the File to onComplete.
  // 5. Treat every incoming message as untrusted: an index outside the
  //    manifest, a chunk larger than promised, or bytes before any MANIFEST
  //    must not crash or fill storage (idea.md section 27).
  throw new Error("Not implemented");
}
