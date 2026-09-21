// Helper to wait for all ICE candidates to be gathered
function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
    } else {
      const checkState = () => {
        if (pc.iceGatheringState === "complete") {
          pc.removeEventListener("icegatheringstatechange", checkState);
          resolve();
        }
      };
      pc.addEventListener("icegatheringstatechange", checkState);
    }
  });
}

/**
 * ICE servers.
 *
 * STUN only tells a browser its public address; the file never goes near it.
 * TURN is a relay that carries the encrypted stream when no direct path
 * exists, so it is opt-in through the environment and always reported to the
 * user as a relayed connection (idea.md rule 4).
 */
const DEFAULT_STUN = [
  "stun:stun.l.google.com:19302",
  "stun:stun.cloudflare.com:3478",
];

function iceServers(): RTCIceServer[] {
  const configured = import.meta.env["VITE_STUN_URLS"];
  const stun =
    typeof configured === "string" && configured
      ? configured.split(",").map((url) => url.trim())
      : DEFAULT_STUN;
  const servers: RTCIceServer[] = stun
    .filter(Boolean)
    .map((urls) => ({ urls }));

  const turnUrl = import.meta.env["VITE_TURN_URL"];
  if (typeof turnUrl === "string" && turnUrl) {
    servers.push({
      urls: turnUrl,
      username: String(import.meta.env["VITE_TURN_USERNAME"] ?? ""),
      credential: String(import.meta.env["VITE_TURN_CREDENTIAL"] ?? ""),
    });
  }
  return servers;
}

/** Whether a relay is even available, which decides what to say on failure. */
export function turnConfigured(): boolean {
  const turnUrl = import.meta.env["VITE_TURN_URL"];
  return typeof turnUrl === "string" && turnUrl.length > 0;
}

export type ConnectionKind = "direct" | "relayed" | "unknown";

/** Pure so it can be tested: reads the nominated pair out of getStats output. */
export function connectionKindFromStats(
  stats: Iterable<Record<string, unknown>>,
): ConnectionKind {
  const entries = [...stats];
  const pair = entries.find(
    (entry) =>
      entry["type"] === "candidate-pair" &&
      (entry["nominated"] === true || entry["selected"] === true) &&
      entry["state"] === "succeeded",
  );
  if (!pair) return "unknown";

  const candidateType = (id: unknown): string =>
    String(
      entries.find((entry) => entry["id"] === id)?.["candidateType"] ?? "",
    );
  const local = candidateType(pair["localCandidateId"]);
  const remote = candidateType(pair["remoteCandidateId"]);
  if (!local && !remote) return "unknown";
  return local === "relay" || remote === "relay" ? "relayed" : "direct";
}

export class PeerSession {
  public pc: RTCPeerConnection;
  public channel: RTCDataChannel | null = null;

  // Callbacks
  // A list, not one callback: the transfer and the debug log both listen.
  private messageListeners: ((data: string | ArrayBuffer) => void)[] = [];
  private onOpenCb?: () => void;
  private onStateChangeCb?: (state: RTCPeerConnectionState) => void;

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: iceServers() });

    // Answerer side: wait for the data channel to arrive from the offerer
    this.pc.ondatachannel = (event) => {
      this.channel = event.channel;
      this.bindChannelEvents();
    };

    // Listen to connection state changes
    this.pc.onconnectionstatechange = () => {
      if (this.onStateChangeCb) {
        this.onStateChangeCb(this.pc.connectionState);
      }
    };
  }

  // Bind the wrapper callbacks to the actual RTCDataChannel events
  private bindChannelEvents() {
    if (!this.channel) return;

    // Without this, binary messages arrive as Blobs and every read of a frame
    // would have to be async.
    this.channel.binaryType = "arraybuffer";

    this.channel.onopen = () => {
      if (this.onOpenCb) this.onOpenCb();
    };

    this.channel.onmessage = (event) => {
      for (const listener of this.messageListeners) listener(event.data);
    };
  }

  // --- Connection Methods ---

  public async createOffer(): Promise<string> {
    // Offerer side MUST create the data channel before creating the offer
    this.channel = this.pc.createDataChannel("shardrop");
    // Bind events immediately for the offerer
    this.bindChannelEvents();

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    // Wait for ICE gathering to finish so the single string contains all connection info
    await waitForIceGathering(this.pc);

    return JSON.stringify(this.pc.localDescription);
  }

  public async acceptOffer(offerStr: string): Promise<string> {
    const offerDesc = JSON.parse(offerStr);
    await this.pc.setRemoteDescription(offerDesc);

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    // Wait for ICE candidates on the answerer side too
    await waitForIceGathering(this.pc);

    return JSON.stringify(this.pc.localDescription);
  }

  public async acceptAnswer(answerStr: string): Promise<void> {
    const answerDesc = JSON.parse(answerStr);
    await this.pc.setRemoteDescription(answerDesc);
  }

  // --- Wrapper API ---

  public send(data: string | ArrayBuffer): void {
    if (this.channel && this.channel.readyState === "open") {
      // Two calls, because send()'s overloads reject a union argument.
      if (typeof data === "string") this.channel.send(data);
      else this.channel.send(data);
    } else {
      console.warn("Data channel is not open.");
    }
  }

  public onMessage(cb: (data: string | ArrayBuffer) => void): void {
    this.messageListeners.push(cb);
  }

  public onOpen(cb: () => void): void {
    this.onOpenCb = cb;
    // Trigger immediately if it's already open
    if (this.channel && this.channel.readyState === "open") {
      cb();
    }
  }

  public onStateChange(cb: (state: RTCPeerConnectionState) => void): void {
    this.onStateChangeCb = cb;
  }

  /** Direct or through a TURN relay: the user is always told which. */
  public async connectionKind(): Promise<ConnectionKind> {
    const stats = await this.pc.getStats();
    return connectionKindFromStats([...stats.values()] as Record<
      string,
      unknown
    >[]);
  }

  public close(): void {
    if (this.channel) this.channel.close();
    this.pc.close();
  }
}

// --- Exported Thin Wrappers ---

export async function createOfferSession(): Promise<{
  offer: string;
  peer: PeerSession;
}> {
  const peer = new PeerSession();
  const offer = await peer.createOffer();
  return { offer, peer };
}

export async function acceptOffer(
  offer: string,
): Promise<{ answer: string; peer: PeerSession }> {
  const peer = new PeerSession();
  const answer = await peer.acceptOffer(offer);
  return { answer, peer };
}

export async function acceptAnswer(
  peer: PeerSession,
  answer: string,
): Promise<void> {
  await peer.acceptAnswer(answer);
}
