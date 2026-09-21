import { describe, expect, it } from "vitest";
import { decodeDataFrame, encodeDataFrame } from "./frame";
import type { PeerSession } from "./peer";
import { createReceiveTransfer, createSendTransfer } from "./transfer";

/**
 * A fake peer pair: whatever one side sends arrives at the other, one task
 * later. Real WebRTC needs two browser tabs; the protocol does not.
 */
type Wire = {
  sender: PeerSession;
  receiver: PeerSession;
  /** Mutates or drops frames in flight, to fake corruption and loss. */
  tamper?: (data: string | ArrayBuffer) => string | ArrayBuffer | null;
  bufferedAmount: number;
};

function createWire(): Wire {
  const wire: Wire = {
    bufferedAmount: 0,
  } as Wire;

  const handlers: Record<
    string,
    ((d: string | ArrayBuffer) => void) | undefined
  > = {};

  const makeSide = (me: "sender" | "receiver"): PeerSession => {
    const other = me === "sender" ? "receiver" : "sender";
    const channel = {
      readyState: "open",
      bufferedAmount: 0,
      bufferedAmountLowThreshold: 0,
      addEventListener: () => {},
    };
    return {
      pc: { sctp: { maxMessageSize: 262144 } },
      channel,
      send(data: string | ArrayBuffer) {
        const delivered =
          me === "sender" && wire.tamper ? wire.tamper(data) : data;
        if (delivered === null) return; // dropped in flight
        setTimeout(() => handlers[other]?.(delivered), 0);
      },
      onMessage(cb: (d: string | ArrayBuffer) => void) {
        handlers[me] = cb;
      },
    } as unknown as PeerSession;
  };

  wire.sender = makeSide("sender");
  wire.receiver = makeSide("receiver");
  return wire;
}

const fileOf = (bytes: number) =>
  new File([new Uint8Array(bytes).map((_, i) => (i * 7) % 256)], "demo.bin", {
    type: "application/octet-stream",
  });

describe("transfer, end to end", () => {
  it("delivers a file whose bytes match the original", async () => {
    const wire = createWire();
    const source = fileOf(1000);

    const received = new Promise<File>((resolve) => {
      createReceiveTransfer(wire.receiver).onComplete(resolve);
    });
    await createSendTransfer(wire.sender, source, 128).start();

    const file = await received;
    expect(file.size).toBe(source.size);
    expect(file.name).toBe("demo.bin");
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(await source.arrayBuffer()),
    );
  });

  it("reports progress up to every chunk", async () => {
    const wire = createWire();
    createReceiveTransfer(wire.receiver);

    const send = createSendTransfer(wire.sender, fileOf(1000), 128);
    const states: string[] = [];
    let lastDone = 0;
    send.onProgress((p) => {
      if (states.at(-1) !== p.state) states.push(p.state);
      lastDone = p.chunksDone;
    });
    await send.start();

    expect(lastDone).toBe(8); // ceil(1000 / 128)
    expect(states).toContain("transferring");
    expect(states.at(-1)).toBe("complete");
  });

  it("retries a corrupted chunk and still delivers the right bytes", async () => {
    const wire = createWire();
    const source = fileOf(600);
    let corrupted = false;

    // Flip a byte in the first frame of chunk 1, once.
    wire.tamper = (data) => {
      if (typeof data === "string" || corrupted) return data;
      const frame = decodeDataFrame(data);
      if (frame.chunkIndex !== 1 || frame.offset !== 0) return data;
      corrupted = true;
      const payload = new Uint8Array(frame.payload);
      payload[0] = payload[0]! ^ 0xff;
      return encodeDataFrame({ ...frame, payload });
    };

    const received = new Promise<File>((resolve) => {
      createReceiveTransfer(wire.receiver).onComplete(resolve);
    });
    const send = createSendTransfer(wire.sender, source, 128);
    let retries = 0;
    send.onProgress((p) => (retries = p.retries));
    await send.start();

    const file = await received;
    expect(corrupted).toBe(true);
    expect(retries).toBeGreaterThan(0);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(await source.arrayBuffer()),
    );
  });

  it("recovers when a chunk never arrives at all", async () => {
    const wire = createWire();
    const source = fileOf(600);
    let dropped = false;

    wire.tamper = (data) => {
      if (typeof data === "string" || dropped) return data;
      const frame = decodeDataFrame(data);
      if (frame.chunkIndex !== 2) return data;
      dropped = true;
      return null; // lost in flight
    };

    const received = new Promise<File>((resolve) => {
      createReceiveTransfer(wire.receiver).onComplete(resolve);
    });
    // A short ACK timeout keeps the test fast; the default is 5s.
    await createSendTransfer(wire.sender, source, 128, {
      ackTimeoutMs: 100,
    }).start();

    const file = await received;
    expect(dropped).toBe(true);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(
      new Uint8Array(await source.arrayBuffer()),
    );
  });
});

describe("receiver, against a hostile sender", () => {
  it("ignores chunk data arriving before a MANIFEST", () => {
    const wire = createWire();
    createReceiveTransfer(wire.receiver);

    expect(() =>
      wire.sender.send(
        encodeDataFrame({
          chunkIndex: 0,
          offset: 0,
          payload: new Uint8Array(4),
        }),
      ),
    ).not.toThrow();
  });

  it("ignores a chunk index outside the manifest", async () => {
    const wire = createWire();
    const received = new Promise<File>((resolve) => {
      createReceiveTransfer(wire.receiver).onComplete(resolve);
    });

    const send = createSendTransfer(wire.sender, fileOf(256), 128);
    const sending = send.start();
    // Chunk 99 does not exist in a two-chunk manifest.
    wire.sender.send(
      encodeDataFrame({
        chunkIndex: 99,
        offset: 0,
        payload: new Uint8Array(128),
      }),
    );
    await sending;

    const file = await received;
    expect(file.size).toBe(256);
  });
});
