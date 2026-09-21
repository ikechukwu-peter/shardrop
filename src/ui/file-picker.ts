import { setRelativePath } from "../core/manifest";

/**
 * Opens a picker from a button rather than relying on a <label> around a
 * hidden input: Safari will not open a picker through a label for an input
 * that is display:none, which left only the folder button working there.
 */
export function onInputPicked(
  input: HTMLInputElement,
  callback: (files: File[]) => void,
): void {
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    if (files.length) callback(files);
    input.value = "";
  });
}

/** Wires a drop zone once, for files and whole folders alike. */
export function onDropped(
  zone: HTMLElement,
  callback: (files: File[]) => void,
): void {
  zone.addEventListener("dragover", (event) => {
    event.preventDefault();
    zone.classList.add("dragging");
  });

  zone.addEventListener("dragleave", () => zone.classList.remove("dragging"));

  zone.addEventListener("drop", (event) => {
    event.preventDefault();
    zone.classList.remove("dragging");

    // Entries must be taken synchronously: the DataTransfer is emptied as soon
    // as this handler returns.
    const entries = [...(event.dataTransfer?.items ?? [])]
      .map((item) => item.webkitGetAsEntry?.())
      .filter((entry): entry is FileSystemEntry => Boolean(entry));

    if (entries.length === 0) {
      const files = [...(event.dataTransfer?.files ?? [])];
      if (files.length) callback(files);
      return;
    }

    void Promise.all(entries.map((entry) => filesIn(entry, ""))).then(
      (nested) => {
        const files = nested.flat();
        if (files.length) callback(files);
      },
    );
  });
}

/**
 * A dropped folder arrives as one directory entry, not as its files. Walk it,
 * recording each file's path so the receiver can rebuild the structure.
 */
async function filesIn(
  entry: FileSystemEntry,
  parent: string,
): Promise<File[]> {
  const path = parent ? `${parent}/${entry.name}` : entry.name;

  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      (entry as FileSystemFileEntry).file(resolve, reject),
    );
    if (parent) setRelativePath(file, path);
    return [file];
  }

  const reader = (entry as FileSystemDirectoryEntry).createReader();
  const children: FileSystemEntry[] = [];
  // readEntries returns results in batches (100 in Chrome) until it is empty.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const nested = await Promise.all(
    children.map((child) => filesIn(child, path)),
  );
  return nested.flat();
}
