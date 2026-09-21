/**
 * Control messages.
 *
 * Chunk bytes travel as binary frames (frame.ts); everything else travels as
 * JSON strings defined here. Keeping the two apart means `typeof event.data`
 * already tells the receiver which kind it is.
 *
 * The state machine that sends and reacts to these lives in transfer.ts.
 */
import type { FileManifest } from "./manifest";

/** Where one file sits in a multi-file send, so the receiver can count along. */
export type BatchPosition = {
  id: string;
  index: number;
  total: number;
  totalBytes: number;
};

export type ControlMessage =
  /** Sender opens: here is what I am about to send. */
  | { type: "MANIFEST"; manifest: FileManifest; batch?: BatchPosition }
  /** Receiver answers: I have these chunks already, send me the rest. */
  | { type: "READY"; transferId: string; haveChunks: number[] }
  /** Receiver verified a chunk's hash and stored it. */
  | { type: "ACK"; transferId: string; chunkIndex: number }
  /** Receiver's hash did not match: send this chunk again. */
  | { type: "RETRY"; transferId: string; chunkIndex: number; reason: string }
  /** Either side pauses; the other stops sending but keeps state. */
  | { type: "PAUSE"; transferId: string }
  | { type: "RESUME"; transferId: string; haveChunks: number[] }
  /** Sender has sent every chunk. */
  | { type: "COMPLETE"; transferId: string }
  /** Receiver has every chunk, all hashes matched. */
  | { type: "VERIFIED"; transferId: string; fileId: string }
  | { type: "CANCEL"; transferId: string; reason: string };

export type ControlMessageType = ControlMessage["type"];

const MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "MANIFEST",
  "READY",
  "ACK",
  "RETRY",
  "PAUSE",
  "RESUME",
  "COMPLETE",
  "VERIFIED",
  "CANCEL",
]);

export function encodeControl(message: ControlMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses a control message from the wire. Everything arriving here is
 * untrusted (idea.md section 27), so the shape is checked before use.
 */
export function decodeControl(text: string): ControlMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("control message is not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("control message is not an object");
  }

  const type: unknown = (parsed as { type?: unknown }).type;
  if (typeof type !== "string" || !MESSAGE_TYPES.has(type)) {
    throw new Error(`unknown control message type: ${String(type)}`);
  }

  return parsed as ControlMessage;
}
