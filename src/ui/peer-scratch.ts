/**
 * Throwaway UI for Milestone 5: manual signaling between two tabs.
 * Delete this once QR Connect (Section 41) exists.
 *
 * It expects this contract from src/core/peer.ts:
 *   createOfferSession(): Promise<{ offer: string; peer: PeerSession }>
 *   acceptOffer(offer: string): Promise<{ answer: string; peer: PeerSession }>
 *   acceptAnswer(peer: PeerSession, answer: string): Promise<void>
 */
import {
  acceptAnswer,
  acceptOffer,
  createOfferSession,
  type PeerSession,
} from "../core/peer";
import { setSession } from "./session";

let session: PeerSession | undefined;

const el = <T extends HTMLElement>(id: string): T =>
  document.querySelector<T>(`#${id}`)!;

const offerOut = el<HTMLTextAreaElement>("offer-out");
const offerIn = el<HTMLTextAreaElement>("offer-in");
const answerOut = el<HTMLTextAreaElement>("answer-out");
const answerIn = el<HTMLTextAreaElement>("answer-in");
const messageIn = el<HTMLInputElement>("message-in");
const logBox = el<HTMLPreElement>("peer-log");
const statusBox = el<HTMLDivElement>("peer-status");

function log(line: string): void {
  const time = new Date().toLocaleTimeString();
  logBox.textContent = `${time}  ${line}\n${logBox.textContent ?? ""}`;
}

function refreshStatus(): void {
  const pc = session?.pc;
  statusBox.textContent = [
    `connection: ${pc?.connectionState ?? "—"}`,
    `ice: ${pc?.iceConnectionState ?? "—"}`,
    `signaling: ${pc?.signalingState ?? "—"}`,
    `channel: ${session?.channel?.readyState ?? "—"}`,
  ].join("   ");
}

/** Wires logging and status updates to a freshly created session. */
function attach(peer: PeerSession): void {
  session = peer;
  setSession(peer);
  peer.onOpen(() => log("channel open — you can send messages now"));
  peer.onMessage((data) => {
    // Chunk frames are binary and constant; logging each one would bury
    // everything else.
    if (typeof data !== "string") return;
    log(`◄ received: ${data.length > 120 ? data.slice(0, 120) + "…" : data}`);
  });
  peer.onStateChange((state) => {
    log(`connection state: ${state}`);
    refreshStatus();
  });
  // Connection/ICE state changes fire often; poll so the status line stays honest.
  setInterval(refreshStatus, 500);
  refreshStatus();
}

/** Reports the error instead of leaving the tab silently dead. */
function run(label: string, fn: () => Promise<void>): void {
  fn().catch((error: unknown) => {
    log(`✕ ${label} failed: ${String(error)}`);
  });
}

el<HTMLButtonElement>("btn-create-offer").addEventListener("click", () => {
  run("create offer", async () => {
    log("gathering ICE candidates…");
    const { offer, peer } = await createOfferSession();
    attach(peer);
    offerOut.value = offer;
    log(`offer ready (${offer.length} chars) — copy it to the other tab`);
  });
});

el<HTMLButtonElement>("btn-accept-offer").addEventListener("click", () => {
  run("accept offer", async () => {
    log("gathering ICE candidates…");
    const { answer, peer } = await acceptOffer(offerIn.value.trim());
    attach(peer);
    answerOut.value = answer;
    log(`answer ready (${answer.length} chars) — copy it back`);
  });
});

el<HTMLButtonElement>("btn-accept-answer").addEventListener("click", () => {
  run("accept answer", async () => {
    if (!session) throw new Error("create an offer first");
    await acceptAnswer(session, answerIn.value.trim());
    log("answer applied — waiting for the channel to open");
  });
});

el<HTMLButtonElement>("btn-send").addEventListener("click", () => {
  const text = messageIn.value;
  if (!text || !session) return;
  session.send(text);
  log(`► sent: ${text}`);
  messageIn.value = "";
});

messageIn.addEventListener("keydown", (event) => {
  if (event.key === "Enter") el<HTMLButtonElement>("btn-send").click();
});

el<HTMLButtonElement>("btn-close").addEventListener("click", () => {
  session?.close();
  log("closed");
  refreshStatus();
});

// Copy buttons: easier than selecting 3 KB of SDP by hand.
for (const id of ["copy-offer", "copy-answer"] as const) {
  el<HTMLButtonElement>(id).addEventListener("click", () => {
    const source = id === "copy-offer" ? offerOut : answerOut;
    void navigator.clipboard.writeText(source.value).then(
      () => log("copied to clipboard"),
      () => log("clipboard blocked — select the text and copy manually"),
    );
  });
}

refreshStatus();
