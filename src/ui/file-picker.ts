/** Wires a click-to-choose input and a drag-and-drop zone to one callback. */
export function onFilesPicked(
  zone: HTMLElement,
  input: HTMLInputElement,
  callback: (files: File[]) => void,
): void {
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    if (files.length) callback(files);
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
    const files = [...(event.dataTransfer?.files ?? [])];
    if (files.length) callback(files);
  });
}
