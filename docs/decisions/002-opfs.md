# 002 — OPFS for received chunks, not IndexedDB

## Context

Received chunks have to live somewhere until the file is complete. Keeping them in memory caps the transfer at roughly the size of a tab's heap, which defeats the point of chunking. The store also has to answer "which chunks do I already have?" after a reload, because that answer is what resume is built on.

## Options

**A. IndexedDB.** The obvious choice, and what idea.md originally called for. Each chunk becomes a record keyed by index. Assembling the file at the end means reading every record back and building one Blob, which either doubles the storage or pushes the whole file through memory.

**B. OPFS (Origin Private File System).** `navigator.storage.getDirectory()` gives a private filesystem. Each chunk is written straight to its offset in one `.part` file with `createWritable({ keepExistingData: true })` and `{ type: "write", position }`. Finishing is `getFile()`, which hands back the whole file without copying it.

**C. File System Access API** (`showSaveFilePicker`). Writes directly to the user's disk, so even the final copy costs nothing. Chromium only, and it needs a user gesture before the transfer starts.

## Decision

Option B, with an in-memory store as a fallback.

- Random-access writes match how chunks arrive: out of order, each at a known offset.
- Finishing is free. No second copy, no reassembly pass.
- It is supported in Chrome, Firefox and Safari, unlike option C.
- Which chunks arrived is persisted beside the data in a small `.state.json`, so resume after a reload needs nothing else.

`MemoryChunkStore` implements the same interface, which keeps the protocol testable without a browser and covers private windows where OPFS is refused.

## Consequences

- Storage is subject to quota. `navigator.storage.estimate()` should be checked before accepting a large transfer, and `persist()` requested. **Not yet done.**
- A partial transfer leaves a `.part` file behind. Abandoned transfers need cleaning up; only `discard()` on CANCEL does that today.
- Resume is keyed on `fileId` plus `chunkSize`: state written with a different chunk size is ignored rather than misapplied (see [001](001-file-id.md)).
- `createWritable` is opened and closed per chunk, which is simple but costs a syscall per chunk. If benchmarks show it hurting, hold one writable open, or move to `createSyncAccessHandle()` inside a worker.
- Option C stays attractive for very large files on Chromium and could be added as a progressive enhancement.
