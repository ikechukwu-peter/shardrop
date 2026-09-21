/**
 * Wire framing.
 *
 * A logical chunk (1-10 MB) is far larger than one DataChannel message, so each
 * chunk is cut into frames that fit under the peer's max-message-size. Control
 * messages travel as JSON strings (see protocol.ts); chunk data travels as
 * binary frames with this 12-byte header:
 *
 *   byte 0      kind (1 = chunk data)
 *   bytes 1-3   reserved (zero)
 *   bytes 4-7   chunk index      (uint32, big endian)
 *   bytes 8-11  offset in chunk  (uint32, big endian)
 *
 * The payload length is implied by the message length, so it is not repeated.
 */

export const FRAME_HEADER_BYTES = 12;
const KIND_CHUNK_DATA = 1;

/** Safe across browsers: Chrome advertises 256 KiB, others far more. */
export const DEFAULT_FRAME_PAYLOAD_BYTES = 16 * 1024;

export type DataFrame = {
  chunkIndex: number;
  offset: number;
  payload: Uint8Array;
};

export function encodeDataFrame(frame: DataFrame): ArrayBuffer {
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(buffer);

  view.setUint8(0, KIND_CHUNK_DATA);
  view.setUint32(4, frame.chunkIndex);
  view.setUint32(8, frame.offset);
  new Uint8Array(buffer, FRAME_HEADER_BYTES).set(frame.payload);

  return buffer;
}

export function decodeDataFrame(buffer: ArrayBuffer): DataFrame {
  if (buffer.byteLength < FRAME_HEADER_BYTES) {
    throw new Error(`frame is shorter than its header (${buffer.byteLength}B)`);
  }

  const view = new DataView(buffer);
  const kind = view.getUint8(0);
  if (kind !== KIND_CHUNK_DATA) {
    throw new Error(`unknown frame kind ${kind}`);
  }

  return {
    chunkIndex: view.getUint32(4),
    offset: view.getUint32(8),
    payload: new Uint8Array(buffer.slice(FRAME_HEADER_BYTES)),
  };
}

/** Cuts one chunk's bytes into frames small enough to send. */
export function* framesForChunk(
  chunkIndex: number,
  bytes: Uint8Array,
  payloadBytes: number = DEFAULT_FRAME_PAYLOAD_BYTES,
): Generator<ArrayBuffer> {
  if (!Number.isSafeInteger(payloadBytes) || payloadBytes <= 0) {
    throw new Error("payloadBytes must be a positive integer");
  }

  for (let offset = 0; offset < bytes.byteLength; offset += payloadBytes) {
    yield encodeDataFrame({
      chunkIndex,
      offset,
      payload: bytes.subarray(offset, offset + payloadBytes),
    });
  }
}

/**
 * Largest payload this connection can carry, from the SDP's max-message-size.
 * Never guess this: Chrome reports 262144, Firefox reports ~1 GB.
 */
export function framePayloadLimit(
  pc: RTCPeerConnection,
  cap = DEFAULT_FRAME_PAYLOAD_BYTES,
): number {
  const negotiated = pc.sctp?.maxMessageSize ?? 0;
  if (negotiated <= FRAME_HEADER_BYTES) return cap;
  return Math.min(cap, negotiated - FRAME_HEADER_BYTES);
}
