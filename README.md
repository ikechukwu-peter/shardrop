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
npm run signal     # signaling relay on :8787 (needed for code/QR pairing)
npm run dev        # then open localhost:5173
npm test           # 65 unit tests (fake wire, no browser)
npm run test:e2e   # 4 Playwright tests: two real tabs, real WebRTC
npm run typecheck
npm run lint
```

The e2e suite starts its own dev server and relay, pairs two browser contexts
both ways (shared link and typed code), transfers files and checks the
downloaded file's SHA-256 against the source.

**Pairing:** press **Create a code**, then open the link (or scan the QR code,
or type the code) on the other device. The two browsers connect themselves.
Then pick a file and press **Send file**.

**Manual mode** is still there, collapsed under the pairing panel: copy the
offer and answer by hand and no server is involved at all, at the cost of
working only on one network.

## How it fits together

```text
src/core/          no DOM, all testable
  chunker.ts       File → lazy chunks
  hasher.ts        SHA-256 → hex
  manifest.ts      what is being sent; transferId + content-derived fileId
  frame.ts         chunk → DataChannel-sized frames (12-byte header)
  protocol.ts      MANIFEST / READY / ACK / RETRY / PAUSE / RESUME / COMPLETE / VERIFIED / CANCEL
  chunk-store.ts   OPFS-backed storage and resume state
  signaling.ts     pairing code → room id + AES-GCM key (HKDF)
  transfer.ts      the state machine: backpressure, window, retry, verify
  peer.ts          RTCPeerConnection + DataChannel

src/ui/            rendering only; correctness lives in core
server/signal.js   ~70-line signaling relay: no file, no plaintext, no storage
e2e/               Playwright: two real browser tabs
docs/protocol.md   the wire protocol
docs/decisions/    why the non-obvious choices were made
```

## Things worth knowing

**A logical chunk is not a wire message.** The SDP reports `max-message-size: 262144` in Chrome, and other browsers differ, so chunks (1–10 MB) are cut into frames sized from `pc.sctp.maxMessageSize` at runtime.

**A DataChannel is already reliable and encrypted.** Per-chunk hashes therefore do not guard against network corruption, which cannot happen; they guard against bugs, storage faults and a hostile peer. ACKs exist for progress and resume, not for delivery.

**The relay is untrusted.** One 80-bit pairing code is the only secret: HKDF derives the relay's room id from it _and_ an AES-256-GCM key that never leaves the browser, so the relay sees an opaque room id and ciphertext. This matters because the SDP carries the DTLS fingerprint — a relay able to rewrite it could sit inside a supposedly direct connection. The code rides in the URL fragment, which browsers never send to a server. See [decision 003](docs/decisions/003-signaling.md).

**Cross-network still depends on ICE.** STUN is configured, so most networks connect directly. Peers behind symmetric NAT or blocked UDP need TURN, which is not set up yet. Nothing silently falls back to a relay.

## Status

Working: chunking, hashing, manifests, code/QR pairing with encrypted
signaling, manual signaling, transfer with backpressure, verification, retry,
pause/resume, OPFS storage.

Not built: TURN for the networks that need it, plus the direct-vs-relayed
indicator that has to come with it; out-of-band fingerprint verification
(decision 003); Web Workers for hashing; multi-file transfers; storage-quota
checks.

## Credits

The chunker, hasher and manifest, including the content-derived `fileId`, were written by hand. The transport layer (framing, storage, transfer state machine) and the UI were written with AI assistance, reviewed and tested; the design decisions and the trade-offs in `docs/decisions/` are documented as they were reasoned through.
