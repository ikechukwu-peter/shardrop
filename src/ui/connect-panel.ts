/**
 * Pairing UI: one side creates a code, the other opens the link or types it.
 * The relay only ever sees an encrypted envelope and a derived room id.
 */
import QRCode from "qrcode";
import { acceptAnswer, acceptOffer, createOfferSession } from "../core/peer";
import {
  SignalingChannel,
  createPairingCode,
  formatPairingCode,
  pairingCodeFromUrl,
  pairingUrl,
} from "../core/signaling";
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
const status = el<HTMLDivElement>("connect-status");

let channel: SignalingChannel | undefined;

function report(line: string): void {
  status.textContent = line;
}

function watch(active: SignalingChannel): void {
  active.onError(report);
}

/** Host: create the code, wait for the other side, then offer. */
async function host(): Promise<void> {
  const code = createPairingCode();
  codeText.textContent = formatPairingCode(code);
  const url = pairingUrl(code, location.href);
  linkText.textContent = url;
  linkText.href = url;
  codeBox.hidden = false;
  await QRCode.toCanvas(qrCanvas, url, { width: 180, margin: 1 });

  report("waiting for the other side to open the link…");
  channel = await SignalingChannel.join(code);
  watch(channel);

  channel.onPaired(() => {
    void (async () => {
      report("someone joined — offering a connection…");
      const { offer, peer } = await createOfferSession();
      setSession(peer);
      peer.onOpen(() => report("connected — ready to send"));
      await channel?.send({ type: "offer", sdp: offer });
    })();
  });

  channel.onMessage((message) => {
    if (message.type !== "answer") return;
    report("answer received — connecting…");
    const peer = getSession();
    if (peer) run("applying the answer", acceptAnswer(peer, message.sdp));
  });
}

/** Guest: join the room and answer whatever offer arrives. */
async function guest(code: string): Promise<void> {
  codeText.textContent = formatPairingCode(code);
  codeBox.hidden = false;
  qrCanvas.hidden = true;
  linkText.hidden = true;

  report("connecting to the relay…");
  channel = await SignalingChannel.join(code);
  watch(channel);
  report("waiting for an offer…");

  channel.onMessage((message) => {
    if (message.type !== "offer") return;
    void (async () => {
      report("offer received — answering…");
      const { answer, peer } = await acceptOffer(message.sdp);
      setSession(peer);
      peer.onOpen(() => report("connected — ready to receive"));
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
