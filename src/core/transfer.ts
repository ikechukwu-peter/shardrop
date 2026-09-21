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
import { hashChunk } from "./hasher";
import { createFileManifest, type FileManifest } from "./manifest";
import type { PeerSession } from "./peer";
import { decodeControl, encodeControl } from "./protocol";

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
  const changed = createSignal();

  let manifest: FileManifest | undefined;
  let onReady: ((haveChunks: number[]) => void) | undefined;
  let verified: (() => void) | undefined;

  /** Chunks waiting to be sent; RETRY puts one back. */
  const queue: number[] = [];
  const unacked = new Set<number>();
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
        tracker.chunkDone(message.chunkIndex);
        break;
      case "RETRY": {
        unacked.delete(message.chunkIndex);
        const tries = (attempts.get(message.chunkIndex) ?? 0) + 1;
        attempts.set(message.chunkIndex, tries);
        tracker.retried();
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

    for (const frame of framesForChunk(index, bytes, payloadBytes)) {
      await waitWhilePausedOrBuffered();
      if (stopped) return;
      peer.send(frame);
    }
    unacked.add(index);
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
        peer.send(encodeControl({ type: "MANIFEST", manifest }));
        const haveChunks = await ready;

        // Chunks the receiver already holds are counted as done, not resent:
        // this is the whole of resume on the sending side.
        for (const index of haveChunks) tracker.chunkDone(index);

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
  let completeListener: ((file: File) => void) | undefined;

  let manifest: FileManifest | undefined;
  let store: ChunkStore | undefined;
  /** Chunk being assembled from frames, keyed by index. */
  const assembling = new Map<number, { bytes: Uint8Array; filled: number }>();
  let paused = false;

  function transferId(): string {
    return manifest?.transferId ?? "";
  }

  async function onManifest(incoming: FileManifest): Promise<void> {
    manifest = incoming;
    store = await createChunkStore(incoming);
    tracker.begin(incoming);
    for (const index of store.received()) tracker.chunkDone(index);
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
    const hash = await hashChunk(new Blob([partial.bytes as BlobPart]));
    if (hash !== meta.hash) {
      tracker.retried();
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
    completeListener?.(file);
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
          await onManifest(message.manifest);
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

    handle().catch((error: unknown) => tracker.fail(String(error)));
  });

  return {
    onProgress: (listener) => tracker.subscribe(listener),
    onComplete: (listener) => (completeListener = listener),

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
  private bytesDone = 0;
  private retries = 0;
  private error?: string;
  private startedAt = 0;

  subscribe(listener: ProgressListener): void {
    this.listeners.push(listener);
    listener(this.snapshot());
  }

  begin(manifest: FileManifest): void {
    this.manifest = manifest;
    this.startedAt = Date.now();
    this.emit();
  }

  setState(state: TransferState): void {
    this.state = state;
    this.emit();
  }

  chunkDone(index: number): void {
    if (this.done.has(index)) return;
    this.done.add(index);
    this.bytesDone += this.manifest?.chunks[index]?.size ?? 0;
    this.emit();
  }

  retried(): void {
    this.retries++;
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
      chunksDone: this.done.size,
      chunksTotal: this.manifest?.totalChunks ?? 0,
      bytesDone: this.bytesDone,
      bytesTotal: this.manifest?.size ?? 0,
      bytesPerSecond: seconds > 0 ? this.bytesDone / seconds : 0,
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
