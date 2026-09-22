import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PeerSession } from "./peer";

/**
 * Just enough of RTCPeerConnection and RTCDataChannel to put events in a
 * chosen order. The race below depends on timing, so a real browser would
 * reproduce it only sometimes; a fake reproduces it every time.
 */
class FakeChannel {
  readyState: RTCDataChannelState;
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readyState: RTCDataChannelState) {
    this.readyState = readyState;
  }

  open(): void {
    this.readyState = "open";
    this.onopen?.();
  }
}

class FakePeerConnection {
  ondatachannel: ((event: { channel: FakeChannel }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
}

/** Hands a channel to the joining side, as the browser would. */
function deliverChannel(peer: PeerSession, channel: FakeChannel): void {
  (peer.pc as unknown as FakePeerConnection).ondatachannel?.({ channel });
}

describe("PeerSession on the joining side", () => {
  beforeEach(() => {
    vi.stubGlobal("RTCPeerConnection", FakePeerConnection);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports open when the channel was already open on arrival", () => {
    // The race: the channel opened before ondatachannel handed it over, so its
    // open event fired before anything was listening.
    const peer = new PeerSession([]);
    let opened = 0;
    peer.onOpen(() => opened++);

    deliverChannel(peer, new FakeChannel("open"));

    expect(opened).toBe(1);
  });

  it("reports open when the channel opens after it arrives", () => {
    const peer = new PeerSession([]);
    let opened = 0;
    peer.onOpen(() => opened++);

    const channel = new FakeChannel("connecting");
    deliverChannel(peer, channel);
    expect(opened).toBe(0);

    channel.open();
    expect(opened).toBe(1);
  });

  it("reports open when the listener is attached after the channel opened", () => {
    const peer = new PeerSession([]);
    deliverChannel(peer, new FakeChannel("open"));

    let opened = 0;
    peer.onOpen(() => opened++);

    expect(opened).toBe(1);
  });

  it("tells a listener once, even if the native event also arrives", () => {
    const peer = new PeerSession([]);
    let opened = 0;
    peer.onOpen(() => opened++);

    const channel = new FakeChannel("open");
    deliverChannel(peer, channel); // replayed: already open on arrival
    channel.open(); // and then the native event after all

    expect(opened).toBe(1);
  });

  it("still tells a listener registered after the open", () => {
    const peer = new PeerSession([]);
    let first = 0;
    let second = 0;
    peer.onOpen(() => first++);
    deliverChannel(peer, new FakeChannel("open"));

    peer.onOpen(() => second++);

    expect(first).toBe(1);
    expect(second).toBe(1);
  });
});
