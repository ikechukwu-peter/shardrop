import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRAME_PAYLOAD_BYTES,
  FRAME_HEADER_BYTES,
  decodeDataFrame,
  encodeDataFrame,
  framePayloadLimit,
  framesForChunk,
} from "./frame";

describe("data frames", () => {
  it("round-trips index, offset and payload", () => {
    const payload = new Uint8Array([1, 2, 3, 250, 255]);
    const decoded = decodeDataFrame(
      encodeDataFrame({ chunkIndex: 7, offset: 4096, payload }),
    );

    expect(decoded.chunkIndex).toBe(7);
    expect(decoded.offset).toBe(4096);
    expect(decoded.payload).toEqual(payload);
  });

  it("survives large indexes and offsets", () => {
    const decoded = decodeDataFrame(
      encodeDataFrame({
        chunkIndex: 4_294_967_295,
        offset: 4_294_967_295,
        payload: new Uint8Array(0),
      }),
    );

    expect(decoded.chunkIndex).toBe(4_294_967_295);
    expect(decoded.offset).toBe(4_294_967_295);
  });

  it("rejects a frame shorter than its header", () => {
    expect(() => decodeDataFrame(new ArrayBuffer(4))).toThrow("shorter");
  });

  it("rejects an unknown frame kind", () => {
    const buffer = new ArrayBuffer(FRAME_HEADER_BYTES);
    new DataView(buffer).setUint8(0, 99);
    expect(() => decodeDataFrame(buffer)).toThrow("unknown frame kind");
  });
});

describe("framesForChunk", () => {
  it("splits a chunk into frames that carry every byte in order", () => {
    const bytes = new Uint8Array(1000).map((_, i) => i % 256);

    const frames = [...framesForChunk(3, bytes, 256)].map(decodeDataFrame);

    expect(frames.map((f) => f.offset)).toEqual([0, 256, 512, 768]);
    expect(frames.every((f) => f.chunkIndex === 3)).toBe(true);
    expect(frames.at(-1)?.payload.byteLength).toBe(232);

    const rebuilt = new Uint8Array(1000);
    for (const frame of frames) rebuilt.set(frame.payload, frame.offset);
    expect(rebuilt).toEqual(bytes);
  });

  it("emits a single frame when the chunk fits", () => {
    expect([...framesForChunk(0, new Uint8Array(10), 256)]).toHaveLength(1);
  });

  it("emits nothing for an empty chunk", () => {
    expect([...framesForChunk(0, new Uint8Array(0), 256)]).toHaveLength(0);
  });

  it("rejects a non-positive payload size", () => {
    expect(() => [...framesForChunk(0, new Uint8Array(4), 0)]).toThrow(
      "positive integer",
    );
  });
});

describe("framePayloadLimit", () => {
  const fakePc = (maxMessageSize?: number) =>
    ({ sctp: maxMessageSize ? { maxMessageSize } : null }) as RTCPeerConnection;

  it("leaves room for the header", () => {
    expect(framePayloadLimit(fakePc(8192))).toBe(8192 - FRAME_HEADER_BYTES);
  });

  it("never exceeds the cap, however large the peer's limit", () => {
    expect(framePayloadLimit(fakePc(1_073_741_823))).toBe(
      DEFAULT_FRAME_PAYLOAD_BYTES,
    );
  });

  it("falls back to the cap before the connection is up", () => {
    expect(framePayloadLimit(fakePc())).toBe(DEFAULT_FRAME_PAYLOAD_BYTES);
  });
});
