import "./ui/peer-scratch";
import { onFilePicked } from "./ui/file-picker";

const zone = document.querySelector<HTMLElement>("#drop-zone")!;
const input = document.querySelector<HTMLInputElement>("#file-input")!;
const output = document.querySelector<HTMLPreElement>("#output")!;

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent =
    bytes === 0 ? 0 : Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = Math.min(exponent, units.length - 1);
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

onFilePicked(zone, input, (file) => {
  output.textContent = [
    `Name:          ${file.name}`,
    `Size:          ${formatBytes(file.size)} (${file.size} bytes)`,
    `Type:          ${file.type || "unknown"}`,
    `Last modified: ${new Date(file.lastModified).toLocaleString()}`,
  ].join("\n");
});
