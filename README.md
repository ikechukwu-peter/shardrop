# Zendrop

Chunked, verified, resumable file transfer directly between two browsers. The file is split, hashed and streamed over a WebRTC DataChannel; no server ever receives it.

```text
File → chunk → hash → manifest → frames → DataChannel → verify → store → reassemble
```

## What it does

- **Chunks a file without loading it into memory.** `Blob.slice()` and a generator, so a multi-gigabyte file streams with flat memory use.
- **Verifies every chunk.** SHA-256 per chunk, checked on arrival. A chunk that fails is re-requested, never stored.
- **Respects backpressure.** The sender stops while the DataChannel has more than 1 MB queued and waits for `bufferedamountlow`, with at most 8 chunks in flight. Without this, a large file kills the tab.
- **Resumes.** Chunks are written to their offset in an OPFS file and which ones arrived is persisted, so an interrupted transfer continues instead of restarting.
- **Recovers from loss and corruption.** A corrupted chunk triggers RETRY; a chunk lost entirely is caught by an ACK timeout, since nothing else would ever report it.
- **Never trusts the wire.** Indexes outside the manifest, over-long chunks and data arriving before a manifest are all rejected.

## Run it

```sh
npm install
npm run dev        # then open localhost:5173 in two tabs
npm test           # 48 unit tests (fake wire, no browser)
npm run test:e2e   # 2 Playwright tests: two real tabs, real WebRTC
npm run typecheck
npm run lint
```

The e2e suite starts its own dev server on port 5174, connects two browser
contexts through manual signaling, transfers a 1.2 MB file and checks the
downloaded file's SHA-256 against the source.

Two tabs, manual signaling: **Create offer** in tab A → paste into tab B → **Accept offer** → paste the answer back into tab A → **Accept answer**. Once the channel is open, pick a file in tab A and press **Send file**.

## How it fits together

```text
src/core/          no DOM, all testable
  chunker.ts       File → lazy chunks
  hasher.ts        SHA-256 → hex
  manifest.ts      what is being sent; transferId + content-derived fileId
  frame.ts         chunk → DataChannel-sized frames (12-byte header)
  protocol.ts      MANIFEST / READY / ACK / RETRY / PAUSE / RESUME / COMPLETE / VERIFIED / CANCEL
  chunk-store.ts   OPFS-backed storage and resume state
  transfer.ts      the state machine: backpressure, window, retry, verify
  peer.ts          RTCPeerConnection + DataChannel

src/ui/            rendering only; correctness lives in core
docs/protocol.md   the wire protocol
docs/decisions/    why the non-obvious choices were made
```

## Things worth knowing

**A logical chunk is not a wire message.** The SDP reports `max-message-size: 262144` in Chrome, and other browsers differ, so chunks (1–10 MB) are cut into frames sized from `pc.sctp.maxMessageSize` at runtime.

**A DataChannel is already reliable and encrypted.** Per-chunk hashes therefore do not guard against network corruption, which cannot happen; they guard against bugs, storage faults and a hostile peer. ACKs exist for progress and resume, not for delivery.

**"No server" has limits.** Signaling is manual copy-paste, which works without any infrastructure but only reliably on one network. Cross-network connections need STUN, and some need a TURN relay. See section 41 of [idea.md](idea.md) for the planned QR Connect design. Nothing here silently falls back to a relay.

## Status

Working: chunking, hashing, manifests, manual signaling, transfer with backpressure, verification, retry, pause/resume, OPFS storage.

Not built: QR pairing and cross-network signaling (idea.md §41), application-level encryption (§42.3 explains why it is lower priority than authenticating the signaling path), Web Workers for hashing, multi-file transfers, storage-quota checks.

## Credits

The chunker, hasher and manifest, including the content-derived `fileId`, were written by hand. The transport layer (framing, storage, transfer state machine) and the UI were written with AI assistance, reviewed and tested; the design decisions and the trade-offs in `docs/decisions/` are documented as they were reasoned through.
