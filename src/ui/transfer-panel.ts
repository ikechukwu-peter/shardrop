/**
 * Transfer UI: pick a file, watch the shards land, save what arrives.
 * It only renders TransferProgress — correctness lives in transfer.ts.
 */
import { checkQuota } from "../core/chunk-store";
import {
  createReceiveTransfer,
  createSendBatch,
  type BatchTransfer,
  type Transfer,
  type TransferProgress,
} from "../core/transfer";
import { onFilesPicked } from "./file-picker";
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
const folderButton = el<HTMLButtonElement>("btn-pick-folder");
const folderInput = el<HTMLInputElement>("folder-input");
const receivedList = el<HTMLUListElement>("received-list");
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

let selectedFiles: File[] = [];
let active: Transfer | undefined;
let sending: BatchTransfer | undefined;
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
  const name = progress.manifest?.path ?? progress.manifest?.name;
  const position = progress.batch
    ? `File ${progress.batch.index + 1} of ${progress.batch.total}`
    : undefined;
  headline.textContent = [position, name, HEADLINES[progress.state]]
    .filter(Boolean)
    .join(" · ");

  const remaining = progress.bytesTotal - progress.bytesDone;
  const eta = progress.bytesPerSecond
    ? remaining / progress.bytesPerSecond
    : Infinity;

  figures.shards.textContent = progress.chunksTotal
    ? `${progress.chunksDone} / ${progress.chunksTotal}`
    : "—";
  const bytesDone = progress.batch?.bytesDone ?? progress.bytesDone;
  const bytesTotal = progress.batch?.bytesTotal ?? progress.bytesTotal;
  figures.bytes.textContent = bytesTotal
    ? `${formatBytes(bytesDone)} / ${formatBytes(bytesTotal)}`
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

function describeSelection(files: File[]): string {
  const total = files.reduce((sum, file) => sum + file.size, 0);
  if (files.length === 1) {
    const file = files[0]!;
    return [
      file.webkitRelativePath || file.name,
      `${formatBytes(file.size)} · ${file.size} bytes`,
      file.type || "type unknown",
    ].join("\n");
  }

  const shown = files
    .slice(0, 6)
    .map((file) => `  ${file.webkitRelativePath || file.name}`);
  if (files.length > shown.length) {
    shown.push(`  and ${files.length - shown.length} more`);
  }
  return [`${files.length} files · ${formatBytes(total)}`, ...shown].join("\n");
}

function selectFiles(files: File[]): void {
  selectedFiles = files;
  output.textContent = describeSelection(files);
  sendButton.disabled = files.length === 0;
  sendButton.textContent =
    files.length > 1 ? `Send ${files.length} files` : "Send file";
  headline.textContent = "Ready to send.";
}

onFilesPicked(zone, input, selectFiles);
onFilesPicked(zone, folderInput, selectFiles);
folderButton.addEventListener("click", () => folderInput.click());

// Both sides listen: the receiving half only wakes up when a MANIFEST arrives.
onSession((peer) => {
  const receive = createReceiveTransfer(peer);

  // Refusing up front beats dying at 80%: the sender is told why.
  receive.onAccept(async (manifest) => {
    const verdict = await checkQuota(manifest.size);
    return verdict.ok ? null : `${manifest.name} ${verdict.reason}`;
  });

  receive.onProgress((progress) => {
    if (sending) return; // this tab is the sender; its own progress wins
    active = receive;
    render(progress);
  });

  receive.onComplete((file, path) => {
    receivedFile = file;
    saveButton.disabled = false;
    saveButton.textContent = "Save file";
    addReceived(file, path);
  });
});

/** Every file that arrives gets its own row and its own download link. */
function addReceived(file: File, path: string): void {
  const row = document.createElement("li");

  const name = document.createElement("span");
  name.className = "path";
  name.textContent = path;

  const size = document.createElement("span");
  size.className = "size";
  size.textContent = formatBytes(file.size);

  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.textContent = "Save";

  row.append(name, size, link);
  receivedList.append(row);
}

sendButton.addEventListener("click", () => {
  const peer = getSession();
  if (selectedFiles.length === 0 || !peer) {
    headline.textContent = "Pair with another device first.";
    return;
  }

  const transfer = createSendBatch(
    peer,
    selectedFiles,
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
