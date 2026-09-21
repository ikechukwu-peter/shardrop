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

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class PeerSession {
  public pc: RTCPeerConnection;
  public channel: RTCDataChannel | null = null;

  // Callbacks
  // A list, not one callback: the transfer and the debug log both listen.
  private messageListeners: ((data: string | ArrayBuffer) => void)[] = [];
  private onOpenCb?: () => void;
  private onStateChangeCb?: (state: RTCPeerConnectionState) => void;

  constructor() {
    this.pc = new RTCPeerConnection(rtcConfig);

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
    this.channel = this.pc.createDataChannel("zendrop");
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
