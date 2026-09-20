/** Wires a click-to-choose input and a drag-and-drop zone to one callback. */
export function onFilePicked(
  zone: HTMLElement,
  input: HTMLInputElement,
  callback: (file: File) => void,
): void {
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) callback(file);
    input.value = "";
  });

  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });

  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));

  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");
    const file = event.dataTransfer?.files[0];
    if (file) callback(file);
  });
}
