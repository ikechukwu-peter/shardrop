import { afterEach, describe, expect, it, vi } from "vitest";
import type { SignalingMessage } from "./signaling";
import {
  RELAY_CONNECT_TIMEOUT_MS,
  SignalingChannel,
  createPairingCode,
  deriveSignalingSecrets,
  formatPairingCode,
  normalizePairingCode,
  openMessage,
  pairingCodeFromUrl,
  pairingUrl,
  sealMessage,
} from "./signaling";

describe("pairing codes", () => {
  it("creates 16 characters in groups of four", () => {
    expect(createPairingCode()).toMatch(
      /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/,
    );
  });

  it("never repeats a code", () => {
    const codes = new Set(
      Array.from({ length: 200 }, () => createPairingCode()),
    );
    expect(codes.size).toBe(200);
  });

  it("omits the letters that are misread aloud", () => {
    const codes = Array.from({ length: 200 }, () => createPairingCode()).join(
      "",
    );
    expect(codes).not.toMatch(/[ILOU]/);
  });

  it("accepts a code however it was typed", () => {
    const code = createPairingCode();
    const typed = code.toLowerCase().replace(/-/g, " ");
    expect(normalizePairingCode(typed)).toBe(normalizePairingCode(code));
  });

  it("rejects a code of the wrong length", () => {
    expect(() => normalizePairingCode("ABCD")).toThrow("16 characters");
  });
});

describe("pairing links", () => {
  it("puts the code in the fragment, never the query", () => {
    const code = createPairingCode();
    const url = pairingUrl(code, "https://shardrop.example/app?x=1");
    expect(url).toBe(
      `https://shardrop.example/app?x=1#c=${normalizePairingCode(code)}`,
    );
    expect(new URL(url).search).toBe("?x=1");
  });

  it("reads the code back out of a link", () => {
    const code = createPairingCode();
    const url = pairingUrl(code, "https://shardrop.example/");
    expect(pairingCodeFromUrl(url)).toBe(normalizePairingCode(code));
  });

  it("returns null when there is no code to find", () => {
    expect(pairingCodeFromUrl("https://shardrop.example/")).toBeNull();
    expect(pairingCodeFromUrl("https://shardrop.example/#c=nope")).toBeNull();
  });
});

describe("derived secrets", () => {
  it("gives the same room id to both sides of one code", async () => {
    const code = createPairingCode();
    const a = await deriveSignalingSecrets(code);
    const b = await deriveSignalingSecrets(formatPairingCode(code));
    expect(a.roomId).toBe(b.roomId);
  });

  it("gives different codes different rooms", async () => {
    const a = await deriveSignalingSecrets(createPairingCode());
    const b = await deriveSignalingSecrets(createPairingCode());
    expect(a.roomId).not.toBe(b.roomId);
  });

  it("does not leak the code: the room id is a 128-bit hash", async () => {
    const code = createPairingCode();
    const { roomId } = await deriveSignalingSecrets(code);
    expect(roomId).toHaveLength(32);
    expect(roomId).not.toContain(normalizePairingCode(code));
  });
});

describe("sealed signaling envelopes", () => {
  const offer: SignalingMessage = {
    type: "offer",
    sdp: "v=0\r\na=fingerprint:sha-256 AA:BB",
  };

  it("round-trips a message for whoever has the code", async () => {
    const { key } = await deriveSignalingSecrets(createPairingCode());
    expect(await openMessage(key, await sealMessage(key, offer))).toEqual(
      offer,
    );
  });

  it("hides the SDP from anyone reading the wire", async () => {
    const { key } = await deriveSignalingSecrets(createPairingCode());
    const sealed = await sealMessage(key, offer);
    expect(sealed).not.toContain("fingerprint");
    expect(sealed).not.toContain("v=0");
  });

  it("uses a fresh nonce, so the same offer looks different each time", async () => {
    const { key } = await deriveSignalingSecrets(createPairingCode());
    expect(await sealMessage(key, offer)).not.toBe(
      await sealMessage(key, offer),
    );
  });

  it("refuses a message sealed with another code", async () => {
    const mine = await deriveSignalingSecrets(createPairingCode());
    const theirs = await deriveSignalingSecrets(createPairingCode());
    const sealed = await sealMessage(theirs.key, offer);
    await expect(openMessage(mine.key, sealed)).rejects.toThrow();
  });

  it("refuses a tampered message: a swapped fingerprint cannot get through", async () => {
    const { key } = await deriveSignalingSecrets(createPairingCode());
    const sealed = await sealMessage(key, offer);
    const [iv, body] = sealed.split(".");
    const flipped = `${iv}.${body!.slice(0, -2)}${body!.at(-1)}${body!.at(-2)}`;
    await expect(openMessage(key, flipped)).rejects.toThrow();
  });

  it("rejects a malformed envelope", async () => {
    const { key } = await deriveSignalingSecrets(createPairingCode());
    await expect(openMessage(key, "not-an-envelope")).rejects.toThrow(
      "malformed",
    );
  });
});

describe("joining the relay", () => {
  /** A WebSocket that never opens and never errors: an unreachable relay. */
  class SilentSocket {
    closed = false;
    addEventListener(): void {}
    close(): void {
      this.closed = true;
    }
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("gives up with a clear error instead of waiting forever", async () => {
    vi.useFakeTimers();
    const sockets: SilentSocket[] = [];
    vi.stubGlobal(
      "WebSocket",
      class extends SilentSocket {
        constructor() {
          super();
          sockets.push(this);
        }
      },
    );

    const joining = SignalingChannel.join(
      createPairingCode(),
      "wss://relay.example",
    );
    const outcome = joining.then(
      () => "joined",
      (error: Error) => error.message,
    );

    // Deriving the room id is real crypto: let it finish before the clock moves.
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(RELAY_CONNECT_TIMEOUT_MS);

    expect(await outcome).toContain("did not answer");
    expect(sockets[0]?.closed).toBe(true);
  });
});
