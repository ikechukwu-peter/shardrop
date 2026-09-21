/**
 * The transfer state machine (milestones 9-14).
 *
 * Sender: MANIFEST → wait READY → stream chunks under backpressure → COMPLETE.
 * Receiver: store chunks that pass their hash, ACK them, RETRY the ones that
 * do not, finalize when nothing is missing.
 *
 * See docs/protocol.md for the message sequence and the rules.
 */
import { createChunkStore, type ChunkStore } from "./chunk-store";
import {
  DEFAULT_FRAME_PAYLOAD_BYTES,
  decodeDataFrame,
  framePayloadLimit,
  framesForChunk,
} from "./frame";
import { hashChunkOffThread } from "./hasher";
import { createFileManifest, type FileManifest } from "./manifest";
import type { PeerSession } from "./peer";
import { decodeControl, encodeControl, type BatchPosition } from "./protocol";

/** Stop sending once this much is queued in the DataChannel. */
const HIGH_WATER_MARK = 1024 * 1024;
/** Resume once the queue has drained to here. */
const LOW_WATER_MARK = 256 * 1024;
/** Chunks allowed in flight without an ACK (bandwidth-delay product). */
const WINDOW = 8;
/** Attempts per chunk before the transfer fails. */
const MAX_ATTEMPTS = 3;
const READY_TIMEOUT_MS = 30_000;
/** Silence this long after sending a chunk counts as lost. */
const ACK_TIMEOUT_MS = 5_000;

export type SendOptions = {
  /** Chunks in flight without an ACK. */
  window?: number;
  ackTimeoutMs?: number;
  readyTimeoutMs?: number;
  /** Set when this file is one of several. */
  batch?: BatchPosition;
  /** Bytes already sent by earlier files in the batch. */
  batchBytesBefore?: number;
};

export type TransferState =
  | "idle"
  | "negotiating"
  | "transferring"
  | "paused"
  | "verifying"
  | "complete"
  | "failed"
  | "cancelled";

/** 0 = not here yet, 1 = verified and stored, 2 = failed a hash and resent. */
export type ChunkStatus = Uint8Array;

export type TransferProgress = {
  state: TransferState;
  manifest?: FileManifest;
  /** One byte per chunk, for rendering which shards have landed. */
  chunkStatus: ChunkStatus;
  chunksDone: number;
  chunksTotal: number;
  bytesDone: number;
  bytesTotal: number;
  bytesPerSecond: number;
  retries: number;
  /** Shards that were already stored when this transfer started. */
  resumedChunks: number;
  /** Present while a batch of files is in flight. */
  batch?: {
    index: number;
    total: number;
    bytesDone: number;
    bytesTotal: number;
  };
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
  /** Fires per file, once every one of its chunks has arrived and verified. */
  onComplete(listener: (file: File, path: string) => void): void;
  /** Asked before a file is accepted; reject to refuse it (quota, size). */
  onAccept(check: (manifest: FileManifest) => Promise<string | null>): void;
}

/** Sends several files, or a folder, one after another over one channel. */
export interface BatchTransfer extends Transfer {
  start(): Promise<void>;
}

export function createSendBatch(
  peer: PeerSession,
  files: File[],
  chunkSize: number,
  options: SendOptions = {},
): BatchTransfer {
  const listeners: ProgressListener[] = [];
  const id = crypto.randomUUID();
  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  let current: SendTransfer | undefined;
  let cancelled = false;

  return {
    onProgress: (listener) => listeners.push(listener),
    pause: () => current?.pause(),
    resume: () => current?.resume(),
    cancel: (reason) => {
      cancelled = true;
      current?.cancel(reason);
    },

    async start() {
      let bytesBefore = 0;
      for (const [index, file] of files.entries()) {
        if (cancelled) return;
        const transfer = createSendTransfer(peer, file, chunkSize, {
          ...options,
          batch: { id, index, total: files.length, totalBytes },
          batchBytesBefore: bytesBefore,
        });
        current = transfer;
        for (const listener of listeners) transfer.onProgress(listener);
        await transfer.start();
        bytesBefore += file.size;
      }
    },
  };
}

// ---------------------------------------------------------------- sender

export function createSendTransfer(
  peer: PeerSession,
  file: File,
  chunkSize: number,
  options: SendOptions = {},
): SendTransfer {
  const window = options.window ?? WINDOW;
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const tracker = new ProgressTracker();
  if (options.batch) {
    tracker.setBatch(options.batch, options.batchBytesBefore ?? 0);
  }
  const changed = createSignal();

  let manifest: FileManifest | undefined;
  let onReady: ((haveChunks: number[]) => void) | undefined;
  let verified: (() => void) | undefined;

  /** Chunks waiting to be sent; RETRY puts one back. */
  const queue: number[] = [];
  const unacked = new Set<number>();
  const acked = new Set<number>();
  const attempts = new Map<number, number>();
  let paused = false;
  let stopped = false;
  let failure: string | undefined;

  peer.onMessage((data) => {
    if (typeof data !== "string") return; // the sender expects no binary
    let message;
    try {
      message = decodeControl(data);
    } catch {
      return; // ignore anything malformed rather than dying mid-transfer
    }

    switch (message.type) {
      case "READY":
      case "RESUME": {
        const have = new Set(message.haveChunks);
        if (manifest && queue.length === 0 && unacked.size === 0) {
          for (let i = 0; i < manifest.totalChunks; i++) {
            if (!have.has(i)) queue.push(i);
          }
        }
        paused = false;
        onReady?.(message.haveChunks);
        break;
      }
      case "ACK":
        unacked.delete(message.chunkIndex);
        acked.add(message.chunkIndex);
        tracker.chunkDone(message.chunkIndex);
        break;
      case "RETRY": {
        unacked.delete(message.chunkIndex);
        const tries = (attempts.get(message.chunkIndex) ?? 0) + 1;
        attempts.set(message.chunkIndex, tries);
        tracker.retried(message.chunkIndex);
        if (tries >= MAX_ATTEMPTS) {
          failure = `chunk ${message.chunkIndex} failed ${tries} times: ${message.reason}`;
          stopped = true;
        } else if (!queue.includes(message.chunkIndex)) {
          queue.push(message.chunkIndex);
        }
        break;
      }
      case "PAUSE":
        paused = true;
        break;
      case "VERIFIED":
        verified?.();
        break;
      case "CANCEL":
        failure = `cancelled by the other side: ${message.reason}`;
        stopped = true;
        break;
      default:
        break;
    }
    changed.notify();
  });

  async function waitWhilePausedOrBuffered(): Promise<void> {
    const channel = peer.channel;
    while (!stopped && (paused || overHighWater(channel))) {
      await Promise.race([changed.wait(), drained(channel)]);
    }
  }

  /** Puts unacknowledged chunks back in the queue, counting an attempt each. */
  function requeueUnacked(): void {
    for (const index of unacked) {
      if (acked.has(index)) continue;
      const tries = (attempts.get(index) ?? 0) + 1;
      attempts.set(index, tries);
      if (tries >= MAX_ATTEMPTS) {
        failure = `chunk ${index} was never acknowledged after ${tries} attempts`;
        stopped = true;
        return;
      }
      if (!queue.includes(index)) queue.push(index);
    }
    unacked.clear();
  }

  async function sendChunk(index: number): Promise<void> {
    if (!manifest) throw new Error("no manifest");
    const meta = manifest.chunks[index];
    if (!meta) throw new Error(`chunk ${index} is not in the manifest`);

    const offset = index * manifest.chunkSize;
    const bytes = new Uint8Array(
      await file.slice(offset, offset + meta.size).arrayBuffer(),
    );
    const payloadBytes = peer.channel
      ? framePayloadLimit(peer.pc)
      : DEFAULT_FRAME_PAYLOAD_BYTES;

    if (acked.has(index)) return; // already confirmed; nothing to resend
    // Marked in flight before the first frame goes out. Marking it afterwards
    // loses the race on a fast connection: the ACK arrives while frames are
    // still being sent, deletes nothing, and the chunk is then added to
    // `unacked` forever and resent until the transfer fails.
    unacked.add(index);

    for (const frame of framesForChunk(index, bytes, payloadBytes)) {
      await waitWhilePausedOrBuffered();
      if (stopped) {
        unacked.delete(index);
        return;
      }
      peer.send(frame);
    }
  }

  return {
    onProgress: (listener) => tracker.subscribe(listener),

    async start() {
      try {
        tracker.setState("negotiating");
        manifest = await createFileManifest(file, chunkSize);
        tracker.begin(manifest);

        const channel = peer.channel;
        if (channel) channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

        const ready = new Promise<number[]>((resolve, reject) => {
          onReady = resolve;
          setTimeout(
            () => reject(new Error("receiver never answered READY")),
            readyTimeoutMs,
          );
        });
        peer.send(
          encodeControl(
            options.batch
              ? { type: "MANIFEST", manifest, batch: options.batch }
              : { type: "MANIFEST", manifest },
          ),
        );
        const haveChunks = await ready;

        // Chunks the receiver already holds are counted as done, not resent:
        // this is the whole of resume on the sending side.
        for (const index of haveChunks) tracker.chunkDone(index);
        if (haveChunks.length > 0) tracker.resumedFrom(haveChunks.length);

        tracker.setState("transferring");
        let done = false;
        const allVerified = new Promise<void>(
          (resolve) => (verified = resolve),
        );
        void allVerified.then(() => {
          done = true;
          changed.notify();
        });
        let completeSent = false;

        while (!stopped && !done) {
          // Room in the window and something to send: send it.
          if (queue.length > 0 && unacked.size < window) {
            await waitWhilePausedOrBuffered();
            if (stopped) break;
            const index = queue.shift();
            if (index !== undefined) {
              completeSent = false;
              await sendChunk(index);
            }
            continue;
          }

          // Waiting on ACKs. Silence means the frames never landed: an ACK
          // only ever comes back for a chunk that arrived, so nothing else
          // will tell us about a chunk lost in flight.
          if (unacked.size > 0 || queue.length > 0) {
            const progressed = await changed.waitFor(ackTimeoutMs);
            if (!progressed) requeueUnacked();
            continue;
          }

          // Everything is acknowledged: say so and wait to be told it verified.
          if (!completeSent) {
            completeSent = true;
            tracker.setState("verifying");
            peer.send(
              encodeControl({
                type: "COMPLETE",
                transferId: manifest.transferId,
              }),
            );
          }
          const progressed = await changed.waitFor(ackTimeoutMs);
          if (!progressed && queue.length === 0 && unacked.size === 0) {
            throw new Error("receiver never confirmed the transfer");
          }
        }

        if (failure) throw new Error(failure);
        if (stopped) return;
        tracker.setState("complete");
      } catch (error) {
        tracker.fail(String(error));
        throw error;
      }
    },

    pause() {
      paused = true;
      if (manifest) {
        peer.send(
          encodeControl({ type: "PAUSE", transferId: manifest.transferId }),
        );
      }
      tracker.setState("paused");
      changed.notify();
    },

    resume() {
      paused = false;
      tracker.setState("transferring");
      changed.notify();
    },

    cancel(reason) {
      stopped = true;
      failure = reason;
      if (manifest) {
        peer.send(
          encodeControl({
            type: "CANCEL",
            transferId: manifest.transferId,
            reason,
          }),
        );
      }
      tracker.setState("cancelled");
      changed.notify();
    },
  };
}

// -------------------------------------------------------------- receiver

export function createReceiveTransfer(peer: PeerSession): ReceiveTransfer {
  const tracker = new ProgressTracker();
  let completeListener: ((file: File, path: string) => void) | undefined;
  let acceptCheck:
    ((manifest: FileManifest) => Promise<string | null>) | undefined;

  let manifest: FileManifest | undefined;
  let store: ChunkStore | undefined;
  /** Chunk being assembled from frames, keyed by index. */
  const assembling = new Map<number, { bytes: Uint8Array; filled: number }>();
  let paused = false;
  let batchBytesBefore = 0;

  function transferId(): string {
    return manifest?.transferId ?? "";
  }

  async function onManifest(
    incoming: FileManifest,
    batch?: BatchPosition,
  ): Promise<void> {
    // A refusal has to be explicit: silence would leave the sender waiting.
    const refusal = acceptCheck ? await acceptCheck(incoming) : null;
    if (refusal) {
      peer.send(
        encodeControl({
          type: "CANCEL",
          transferId: incoming.transferId,
          reason: refusal,
        }),
      );
      tracker.fail(refusal);
      return;
    }

    // Each file in a batch starts clean, but keeps the batch counters.
    manifest = incoming;
    assembling.clear();
    tracker.resetForFile();
    store = await createChunkStore(incoming);
    if (batch) {
      tracker.setBatch(batch, batchBytesBefore);
      batchBytesBefore += incoming.size;
    }
    tracker.begin(incoming);
    const already = store.received();
    for (const index of already) tracker.chunkDone(index);
    if (already.length > 0) tracker.resumedFrom(already.length);
    tracker.setState("transferring");
    peer.send(
      encodeControl({
        type: "READY",
        transferId: incoming.transferId,
        haveChunks: store.received(),
      }),
    );
  }

  async function onFrame(buffer: ArrayBuffer): Promise<void> {
    if (!manifest || !store || paused) return; // data before MANIFEST is dropped

    const frame = decodeDataFrame(buffer);
    const meta = manifest.chunks[frame.chunkIndex];
    if (!meta) return; // index outside the manifest
    if (frame.offset + frame.payload.byteLength > meta.size) return; // too long

    let partial = assembling.get(frame.chunkIndex);
    if (!partial) {
      partial = { bytes: new Uint8Array(meta.size), filled: 0 };
      assembling.set(frame.chunkIndex, partial);
    }
    partial.bytes.set(frame.payload, frame.offset);
    partial.filled += frame.payload.byteLength;
    if (partial.filled < meta.size) return;

    assembling.delete(frame.chunkIndex);
    const hash = await hashChunkOffThread(
      new Blob([partial.bytes as BlobPart]),
    );
    if (hash !== meta.hash) {
      tracker.retried(frame.chunkIndex);
      peer.send(
        encodeControl({
          type: "RETRY",
          transferId: transferId(),
          chunkIndex: frame.chunkIndex,
          reason: "hash mismatch",
        }),
      );
      return;
    }

    await store.write(frame.chunkIndex, partial.bytes);
    tracker.chunkDone(frame.chunkIndex);
    peer.send(
      encodeControl({
        type: "ACK",
        transferId: transferId(),
        chunkIndex: frame.chunkIndex,
      }),
    );
  }

  async function onComplete(): Promise<void> {
    if (!manifest || !store) return;

    const missing = store.missing();
    if (missing.length > 0) {
      // The sender thinks it is done; ask again for what never arrived.
      for (const chunkIndex of missing) {
        peer.send(
          encodeControl({
            type: "RETRY",
            transferId: transferId(),
            chunkIndex,
            reason: "never arrived",
          }),
        );
      }
      return;
    }

    tracker.setState("verifying");
    const file = await store.finalize();
    peer.send(
      encodeControl({
        type: "VERIFIED",
        transferId: transferId(),
        fileId: manifest.fileId,
      }),
    );
    tracker.setState("complete");
    completeListener?.(file, manifest.path || manifest.name);
  }

  peer.onMessage((data) => {
    const handle = async () => {
      if (typeof data !== "string") {
        await onFrame(data);
        return;
      }
      const message = decodeControl(data);
      switch (message.type) {
        case "MANIFEST":
          await onManifest(message.manifest, message.batch);
          break;
        case "COMPLETE":
          await onComplete();
          break;
        case "PAUSE":
          paused = true;
          tracker.setState("paused");
          break;
        case "RESUME":
          paused = false;
          tracker.setState("transferring");
          break;
        case "CANCEL":
          tracker.setState("cancelled");
          await store?.discard();
          break;
        default:
          break;
      }
    };

    // A receiver-side failure has to reach the sender, or it just waits for
    // ACKs that will never come.
    handle().catch((error: unknown) => {
      tracker.fail(String(error));
      peer.send(
        encodeControl({
          type: "CANCEL",
          transferId: transferId(),
          reason: `receiver failed: ${String(error)}`,
        }),
      );
    });
  });

  return {
    onProgress: (listener) => tracker.subscribe(listener),
    onComplete: (listener) => (completeListener = listener),
    onAccept: (check) => (acceptCheck = check),

    pause() {
      paused = true;
      peer.send(encodeControl({ type: "PAUSE", transferId: transferId() }));
      tracker.setState("paused");
    },

    resume() {
      paused = false;
      peer.send(
        encodeControl({
          type: "RESUME",
          transferId: transferId(),
          haveChunks: store?.received() ?? [],
        }),
      );
      tracker.setState("transferring");
    },

    cancel(reason) {
      peer.send(
        encodeControl({ type: "CANCEL", transferId: transferId(), reason }),
      );
      tracker.setState("cancelled");
      void store?.discard();
    },
  };
}

// ---------------------------------------------------------------- shared

/** Progress bookkeeping, shared by both sides so the UI reads one shape. */
class ProgressTracker {
  private listeners: ProgressListener[] = [];
  private manifest?: FileManifest;
  private state: TransferState = "idle";
  private done = new Set<number>();
  private status: ChunkStatus = new Uint8Array(0);
  private bytesDone = 0;
  private retries = 0;
  private error: string | undefined;
  private startedAt = 0;
  private resumed = 0;
  private batch?: BatchPosition;
  private batchBytesBefore = 0;

  setBatch(batch: BatchPosition, bytesBefore: number): void {
    this.batch = batch;
    this.batchBytesBefore = bytesBefore;
  }

  subscribe(listener: ProgressListener): void {
    this.listeners.push(listener);
    listener(this.snapshot());
  }

  begin(manifest: FileManifest): void {
    this.manifest = manifest;
    this.status = new Uint8Array(manifest.totalChunks);
    this.startedAt = Date.now();
    this.emit();
  }

  /** Shards that were already here, so the UI can say a transfer continued. */
  resumedFrom(count: number): void {
    this.resumed = count;
    this.emit();
  }

  /**
   * Starts the next file in a batch from zero. Without this the previous
   * file's chunk indexes stay marked done, so nothing new is ever counted.
   */
  resetForFile(): void {
    this.resumed = 0;
    this.done.clear();
    this.bytesDone = 0;
    this.error = undefined;
    this.status = new Uint8Array(0);
  }

  setState(state: TransferState): void {
    this.state = state;
    this.emit();
  }

  chunkDone(index: number): void {
    if (this.done.has(index)) return;
    this.done.add(index);
    if (index < this.status.length) this.status[index] = 1;
    this.bytesDone += this.manifest?.chunks[index]?.size ?? 0;
    this.emit();
  }

  retried(index?: number): void {
    this.retries++;
    if (
      index !== undefined &&
      index < this.status.length &&
      !this.done.has(index)
    ) {
      this.status[index] = 2;
    }
    this.emit();
  }

  fail(error: string): void {
    this.error = error;
    this.state = "failed";
    this.emit();
  }

  private snapshot(): TransferProgress {
    const seconds = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      state: this.state,
      ...(this.manifest ? { manifest: this.manifest } : {}),
      chunkStatus: this.status,
      resumedChunks: this.resumed,
      chunksDone: this.done.size,
      chunksTotal: this.manifest?.totalChunks ?? 0,
      bytesDone: this.bytesDone,
      bytesTotal: this.manifest?.size ?? 0,
      bytesPerSecond: seconds > 0 ? this.bytesDone / seconds : 0,
      ...(this.batch
        ? {
            batch: {
              index: this.batch.index,
              total: this.batch.total,
              bytesDone: this.batchBytesBefore + this.bytesDone,
              bytesTotal: this.batch.totalBytes,
            },
          }
        : {}),
      ...(this.error ? { error: this.error } : {}),
      retries: this.retries,
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** A promise that can be re-armed: "something changed, look again". */
function createSignal() {
  let resolve: () => void = () => {};
  let promise = new Promise<void>((r) => (resolve = r));
  return {
    wait: () => promise,
    /** Resolves true if notified before the timeout, false if it expired. */
    waitFor: (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise.then(() => {
          clearTimeout(timer);
          return true;
        }),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), ms);
        }),
      ]);
    },
    notify: () => {
      resolve();
      promise = new Promise<void>((r) => (resolve = r));
    },
  };
}

function overHighWater(channel: RTCDataChannel | null): boolean {
  return (channel?.bufferedAmount ?? 0) > HIGH_WATER_MARK;
}

/** Resolves when the channel's queue drains below its low-water mark. */
function drained(channel: RTCDataChannel | null): Promise<void> {
  if (!channel) return Promise.resolve();
  return new Promise((resolve) => {
    channel.addEventListener("bufferedamountlow", () => resolve(), {
      once: true,
    });
  });
}
