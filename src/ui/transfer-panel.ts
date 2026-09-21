/**
 * Transfer UI: pick a file, watch it cross, save it on the other side.
 * It only renders TransferProgress — correctness lives in transfer.ts.
 */
import {
  createReceiveTransfer,
  createSendTransfer,
  type SendTransfer,
  type Transfer,
  type TransferProgress,
} from "../core/transfer";
import { onFilePicked } from "./file-picker";
import { getSession, onSession } from "./session";

const el = <T extends HTMLElement>(id: string): T =>
  document.querySelector<T>(`#${id}`)!;

const zone = el<HTMLElement>("drop-zone");
const input = el<HTMLInputElement>("file-input");
const output = el<HTMLPreElement>("output");
const chunkSizeSelect = el<HTMLSelectElement>("chunk-size");
const sendButton = el<HTMLButtonElement>("btn-send-file");
const pauseButton = el<HTMLButtonElement>("btn-pause");
const cancelButton = el<HTMLButtonElement>("btn-cancel");
const saveButton = el<HTMLButtonElement>("btn-save");
const bar = el<HTMLDivElement>("progress-bar");
const stats = el<HTMLDivElement>("transfer-stats");

let selectedFile: File | undefined;
let active: Transfer | undefined;
let sending: SendTransfer | undefined;
let receivedFile: File | undefined;

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent =
    bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = Math.min(exponent, units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.ceil(seconds % 60)}s`;
}

function render(progress: TransferProgress): void {
  const fraction =
    progress.bytesTotal > 0 ? progress.bytesDone / progress.bytesTotal : 0;
  bar.style.width = `${(fraction * 100).toFixed(1)}%`;
  bar.dataset["state"] = progress.state;

  const remaining = progress.bytesTotal - progress.bytesDone;
  const eta = progress.bytesPerSecond
    ? remaining / progress.bytesPerSecond
    : Infinity;

  stats.textContent = [
    `state: ${progress.state}${progress.error ? ` (${progress.error})` : ""}`,
    `chunks: ${progress.chunksDone} / ${progress.chunksTotal}`,
    `${formatBytes(progress.bytesDone)} of ${formatBytes(progress.bytesTotal)}`,
    `${formatBytes(progress.bytesPerSecond)}/s`,
    `eta ${formatDuration(eta)}`,
    `retries: ${progress.retries}`,
    progress.state === "complete" ? "integrity: ✓ every chunk verified" : "",
  ]
    .filter(Boolean)
    .join("\n");

  pauseButton.disabled = !["transferring", "paused"].includes(progress.state);
  pauseButton.textContent = progress.state === "paused" ? "Resume" : "Pause";
  cancelButton.disabled = ["complete", "cancelled", "failed"].includes(
    progress.state,
  );
}

onFilePicked(zone, input, (file) => {
  selectedFile = file;
  output.textContent = [
    `Name:          ${file.name}`,
    `Size:          ${formatBytes(file.size)} (${file.size} bytes)`,
    `Type:          ${file.type || "unknown"}`,
    `Last modified: ${new Date(file.lastModified).toLocaleString()}`,
  ].join("\n");
  sendButton.disabled = false;
});

// Both sides listen: the receiving half only wakes up when a MANIFEST arrives.
onSession((peer) => {
  const receive = createReceiveTransfer(peer);
  receive.onProgress((progress) => {
    if (sending) return; // this tab is the sender; its own progress wins
    active = receive;
    render(progress);
  });
  receive.onComplete((file) => {
    receivedFile = file;
    saveButton.disabled = false;
    saveButton.textContent = `Save ${file.name} (${formatBytes(file.size)})`;
  });
});

sendButton.addEventListener("click", () => {
  const peer = getSession();
  if (!selectedFile || !peer) {
    stats.textContent = "connect to a peer first (manual signaling above)";
    return;
  }

  const transfer = createSendTransfer(
    peer,
    selectedFile,
    Number(chunkSizeSelect.value),
  );
  sending = transfer;
  active = transfer;
  transfer.onProgress(render);
  sendButton.disabled = true;
  transfer.start().catch((error: unknown) => {
    stats.textContent = `failed: ${String(error)}`;
  });
});

pauseButton.addEventListener("click", () => {
  if (!active) return;
  if (pauseButton.textContent === "Pause") active.pause();
  else active.resume();
});

cancelButton.addEventListener("click", () => {
  active?.cancel("cancelled by the user");
});

saveButton.addEventListener("click", () => {
  if (!receivedFile) return;
  const url = URL.createObjectURL(receivedFile);
  const link = document.createElement("a");
  link.href = url;
  link.download = receivedFile.name;
  link.click();
  URL.revokeObjectURL(url);
});
