/**
 * Pairing UI: one side creates a code, the other opens the link or types it.
 * The relay only ever sees an encrypted envelope and a derived room id.
 */
import QRCode from "qrcode";
import {
  acceptAnswer,
  acceptOffer,
  createOfferSession,
  turnConfigured,
  type PeerSession,
} from "../core/peer";
import {
  SignalingChannel,
  createPairingCode,
  formatPairingCode,
  pairingCodeFromUrl,
  pairingUrl,
} from "../core/signaling";
import { connectionSafetyWords } from "../core/verify";
import { getSession, setSession } from "./session";

const el = <T extends HTMLElement>(id: string): T =>
  document.querySelector<T>(`#${id}`)!;

const createButton = el<HTMLButtonElement>("btn-create-code");
const joinButton = el<HTMLButtonElement>("btn-join-code");
const codeInput = el<HTMLInputElement>("code-input");
const codeBox = el<HTMLDivElement>("code-box");
const codeText = el<HTMLElement>("code-text");
const linkText = el<HTMLAnchorElement>("code-link");
const qrCanvas = el<HTMLCanvasElement>("code-qr");
const status = el<HTMLElement>("connect-status");
const pairControls =
  document.querySelector<HTMLElement>("#btn-create-code")!.parentElement!;
const pill = el<HTMLElement>("peer-pill");
const safetyBox = el<HTMLElement>("safety");
const safetyWordsText = el<HTMLElement>("safety-words");

let channel: SignalingChannel | undefined;

function report(line: string, pillState?: string, pillText?: string): void {
  status.textContent = line;
  if (pillState) pill.dataset["state"] = pillState;
  if (pillText) pill.textContent = pillText;
}

function watch(active: SignalingChannel): void {
  active.onError(report);
}

/**
 * Says whether the connection is direct or through a TURN relay, and explains
 * a failure instead of leaving the badge on "connecting" forever.
 */
function watchConnection(peer: PeerSession, role: "send" | "receive"): void {
  const ready = role === "send" ? "Ready to send." : "Ready to receive.";
  /**
   * A failure before this is a network that refuses a direct path; a failure
   * after it is an established connection that dropped. Saying "a TURN relay
   * is needed" about the second is simply wrong.
   */
  let everConnected = false;

  peer.onOpen(() => {
    everConnected = true;
    codeBox.hidden = true;

    // Only the certificates actually in use can produce these words.
    void connectionSafetyWords(peer.pc).then((words) => {
      if (!words) return;
      safetyWordsText.textContent = words.join("  ");
      safetyBox.hidden = false;
    });

    void peer.connectionKind().then((kind) => {
      const label = kind === "relayed" ? "relayed" : "direct";
      report(
        kind === "relayed"
          ? `Connected through a relay, because this network blocks a direct path. ${ready}`
          : `Connected directly. ${ready}`,
        "paired",
        `paired · ${label}`,
      );
    });
  });

  // connectionState aggregates ICE and DTLS, and unlike iceConnectionState it
  // does not report a transient candidate failure as a dead connection.
  peer.pc.addEventListener("connectionstatechange", () => {
    const state = peer.pc.connectionState;

    if (state === "disconnected") {
      report(
        "The connection was interrupted. Trying to recover.",
        "waiting",
        "reconnecting",
      );
      return;
    }

    if (state === "connected" && everConnected) {
      report(`Connected. ${ready}`, "paired", "paired");
      return;
    }

    if (state !== "failed" && state !== "closed") return;

    if (everConnected) {
      report(
        "The connection ended. Pair again to send more.",
        "idle",
        "not connected",
      );
      return;
    }

    report(
      turnConfigured()
        ? "No connection could be established, even through the relay."
        : "This network will not allow a direct connection. A TURN relay is needed, and none is configured.",
      "idle",
      "not connected",
    );
  });
}

/** Host: create the code, wait for the other side, then offer. */
async function host(): Promise<void> {
  const code = createPairingCode();
  codeText.textContent = formatPairingCode(code);
  const url = pairingUrl(code, location.href);
  linkText.textContent = url;
  linkText.href = url;
  codeBox.hidden = false;
  pairControls.hidden = true; // a code exists; the choice is made
  await QRCode.toCanvas(qrCanvas, url, { width: 180, margin: 1 });

  report("Waiting for the other device.", "waiting", "waiting");
  channel = await SignalingChannel.join(code);
  watch(channel);

  channel.onPaired(() => {
    void (async () => {
      report("The other device joined. Connecting.", "waiting", "connecting");
      const { offer, peer } = await createOfferSession();
      setSession(peer);
      // The code has done its job once connected; it is hidden then.
      watchConnection(peer, "send");
      await channel?.send({ type: "offer", sdp: offer });
    })();
  });

  channel.onMessage((message) => {
    if (message.type !== "answer") return;
    report("Answer received. Connecting.", "waiting", "connecting");
    const peer = getSession();
    if (peer) run("applying the answer", acceptAnswer(peer, message.sdp));
  });
}

/** Guest: join the room and answer whatever offer arrives. */
async function guest(code: string): Promise<void> {
  codeText.textContent = formatPairingCode(code);
  codeBox.hidden = false;
  pairControls.hidden = true;
  qrCanvas.hidden = true;
  linkText.hidden = true;

  report("Connecting to the relay.", "waiting", "joining");
  channel = await SignalingChannel.join(code);
  watch(channel);
  report("Waiting for the other device to offer a connection.");

  channel.onMessage((message) => {
    if (message.type !== "offer") return;
    void (async () => {
      report("Offer received. Answering.", "waiting", "connecting");
      const { answer, peer } = await acceptOffer(message.sdp);
      setSession(peer);
      watchConnection(peer, "receive");
      await channel?.send({ type: "answer", sdp: answer });
    })();
  });
}

function run(label: string, work: Promise<void>): void {
  work.catch((error: unknown) => report(`${label} failed: ${String(error)}`));
}

createButton.addEventListener("click", () => {
  createButton.disabled = true;
  run("creating a code", host());
});

joinButton.addEventListener("click", () => {
  const code = codeInput.value.trim();
  if (!code) return;
  joinButton.disabled = true;
  run("joining", guest(code));
});

codeInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") joinButton.click();
});

// Opened from a shared link: pair without the user doing anything.
const fromUrl = pairingCodeFromUrl(location.href);
if (fromUrl) {
  createButton.disabled = true;
  run("joining", guest(fromUrl));
}
