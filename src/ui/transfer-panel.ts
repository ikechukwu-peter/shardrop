/**
 * Transfer UI: pick a file, watch the shards land, save what arrives.
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
const grid = el<HTMLDivElement>("shard-grid");
const headline = el<HTMLParagraphElement>("readout-headline");
const verifyLine = el<HTMLParagraphElement>("verify-line");
const figures = {
  shards: el<HTMLElement>("figure-shards"),
  bytes: el<HTMLElement>("figure-bytes"),
  rate: el<HTMLElement>("figure-rate"),
  eta: el<HTMLElement>("figure-eta"),
  retries: el<HTMLElement>("figure-retries"),
};

/** Above this, one tile stands for several shards: 40k tiles would not render. */
const MAX_TILES = 512;

let selectedFile: File | undefined;
let active: Transfer | undefined;
let sending: SendTransfer | undefined;
let receivedFile: File | undefined;
let tiles: HTMLDivElement[] = [];
let tilesFor = 0;

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

/** One tile per shard, or per group of shards for a very large file. */
function buildGrid(totalChunks: number): void {
  if (tilesFor === totalChunks) return;
  tilesFor = totalChunks;

  const count = Math.min(totalChunks, MAX_TILES);
  grid.classList.remove("idle");
  grid.replaceChildren();

  tiles = Array.from({ length: count }, () => {
    const tile = document.createElement("div");
    tile.className = "shard";
    tile.dataset["status"] = "0";
    grid.append(tile);
    return tile;
  });
}

function paintGrid(progress: TransferProgress): void {
  const total = progress.chunksTotal;
  if (!total) return;
  buildGrid(total);

  const perTile = total / tiles.length;
  tiles.forEach((tile, index) => {
    const from = Math.floor(index * perTile);
    const to = Math.max(from + 1, Math.floor((index + 1) * perTile));

    // A tile covering several shards shows the worst state among them, so a
    // resend is never hidden by its neighbours.
    let status = 1;
    for (let chunk = from; chunk < to && chunk < total; chunk++) {
      const value = progress.chunkStatus[chunk] ?? 0;
      if (value === 2) {
        status = 2;
        break;
      }
      if (value === 0) status = 0;
    }
    if (tile.dataset["status"] !== String(status)) {
      tile.dataset["status"] = String(status);
    }
  });

  grid.setAttribute(
    "aria-label",
    `${progress.chunksDone} of ${total} shards verified`,
  );
}

const HEADLINES: Record<TransferProgress["state"], string> = {
  idle: "Waiting for a file.",
  negotiating: "Reading the file and hashing its shards.",
  transferring: "Sending shards.",
  paused: "Paused. Nothing is lost.",
  verifying: "Checking every shard arrived.",
  complete: "Done. Every shard matched its hash.",
  failed: "Transfer failed.",
  cancelled: "Transfer cancelled.",
};

function render(progress: TransferProgress): void {
  paintGrid(progress);
  headline.textContent = HEADLINES[progress.state];

  const remaining = progress.bytesTotal - progress.bytesDone;
  const eta = progress.bytesPerSecond
    ? remaining / progress.bytesPerSecond
    : Infinity;

  figures.shards.textContent = progress.chunksTotal
    ? `${progress.chunksDone} / ${progress.chunksTotal}`
    : "—";
  figures.bytes.textContent = progress.bytesTotal
    ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}`
    : "—";
  figures.rate.textContent = progress.bytesPerSecond
    ? `${formatBytes(progress.bytesPerSecond)}/s`
    : "—";
  figures.eta.textContent =
    progress.state === "complete" ? "—" : formatDuration(eta);
  figures.retries.textContent = String(progress.retries);

  // The content hash is the evidence that the file arrived intact.
  verifyLine.textContent =
    progress.state === "complete" && progress.manifest
      ? `verified · fileId ${progress.manifest.fileId.slice(0, 16)}…`
      : progress.error
        ? progress.error
        : "";

  pauseButton.disabled = !["transferring", "paused"].includes(progress.state);
  pauseButton.textContent = progress.state === "paused" ? "Resume" : "Pause";
  cancelButton.disabled = ["idle", "complete", "cancelled", "failed"].includes(
    progress.state,
  );
}

onFilePicked(zone, input, (file) => {
  selectedFile = file;
  output.textContent = [
    `${file.name}`,
    `${formatBytes(file.size)} · ${file.size} bytes`,
    `${file.type || "type unknown"} · modified ${new Date(
      file.lastModified,
    ).toLocaleString()}`,
  ].join("\n");
  sendButton.disabled = false;
  headline.textContent = "Ready to send.";
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
    saveButton.textContent = `Save ${file.name}`;
  });
});

sendButton.addEventListener("click", () => {
  const peer = getSession();
  if (!selectedFile || !peer) {
    headline.textContent = "Pair with another device first.";
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
    headline.textContent = "Transfer failed.";
    verifyLine.textContent = String(error);
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

// An idle mosaic, so the page is not empty before anything happens.
grid.classList.add("idle");
grid.replaceChildren(
  ...Array.from({ length: 128 }, () => {
    const tile = document.createElement("div");
    tile.className = "shard";
    return tile;
  }),
);
