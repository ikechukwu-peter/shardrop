import { onFilePicked } from "./ui/file-picker";

const zone = document.querySelector<HTMLElement>("#drop-zone")!;
const input = document.querySelector<HTMLInputElement>("#file-input")!;
const output = document.querySelector<HTMLPreElement>("#output")!;

onFilePicked(zone, input, (file) => {
  // TODO(Milestone 1): show name, size, type and lastModified in `output`.
  // Then experiment with file.slice(start, end) — never file.arrayBuffer() on the whole file.
  console.log(file);
  output.textContent = "";
});
