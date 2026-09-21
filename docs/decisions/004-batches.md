# 004 — Folders as a sequence of files, not a new format

## Context

Sending one file at a time is not how people use a transfer tool: it is "send me those photos" or a whole folder. The protocol had one manifest per connection and no idea a file might be one of many.

## Options

**A. One archive.** Zip the selection in the browser and send a single file. The existing protocol would not change at all. But the sender pays for compressing before anything moves, memory or storage doubles, the receiver gets a zip rather than their files, and progress is one opaque bar.

**B. A batch message listing every file, then the files.** A new `BATCH` control message, then the existing per-file flow. Honest, but it adds protocol surface and a second source of truth about what is coming.

**C. Position on the manifest.** Each file keeps its own `MANIFEST`, which optionally carries `{ id, index, total, totalBytes }`. Files go one after another over the same channel.

**D. Files in parallel.** Interleave several files over the one DataChannel.

## Decision

Option C.

- No new message type: an existing message gains an optional field, so a sender that never sets it behaves exactly as before.
- Each file keeps its own manifest, hashes, store and resume state. A batch is a loop, not a new mode, and per-file resume keeps working untouched.
- The receiver can say "file 3 of 12" and show total bytes because the position carries the totals.
- `FileManifest.path` carries `webkitRelativePath`, so a folder's structure survives; the receiver shows paths and names each download.

Option D was rejected because the channel is a single ordered stream: interleaving costs bookkeeping and wins no throughput (see 42.2). Sequential also means one file's failure does not take the rest with it.

## Consequences

- **Small files are dominated by fixed costs.** Every file pays a manifest round trip and a hash pass, so a thousand tiny files will be slow. Batching small files into one manifest would fix it, and is not done.
- **Order is fixed.** The receiver cannot ask for a particular file first.
- **The receiver holds every finished file** as an OPFS-backed `File` until the page is closed, so the download links stay valid. The sweep keeps completed transfers for an hour for that reason; deleting them as soon as the next file starts broke the earlier download (caught by the folder end-to-end test).
- **Empty folders vanish**, since the file picker only reports files.
