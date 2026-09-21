# Zendrop transfer protocol v0

One file, one DataChannel, two roles: **sender** and **receiver**. Control messages are JSON strings; chunk data is binary frames. `typeof event.data` tells them apart.

## Frames

A logical chunk (1–10 MB) never fits in one DataChannel message, so it is cut into frames:

```text
byte 0      kind (1 = chunk data)
bytes 1-3   reserved
bytes 4-7   chunk index     (uint32 BE)
bytes 8-11  offset in chunk (uint32 BE)
bytes 12+   payload
```

The payload size comes from `framePayloadLimit(pc)`, never from a constant: Chrome advertises 256 KiB, Firefox advertises far more.

## Happy path

```text
Sender                          Receiver
──────                          ────────
MANIFEST  ───────────────────►
          ◄─────────────────── READY { haveChunks: [] }
chunk 0 frames ─────────────►
          ◄─────────────────── ACK 0
chunk 1 frames ─────────────►
          ◄─────────────────── ACK 1
…
COMPLETE  ───────────────────►
          ◄─────────────────── VERIFIED { fileId }
```

## Resume

`READY` and `RESUME` both carry `haveChunks`. The sender sends only what is missing. Chunks already stored survive a reload because the store persists which indexes arrived.

```text
MANIFEST ──────►
        ◄────── READY { haveChunks: [0,1,2,3,4] }   ← from a previous attempt
chunk 5 …                                            ← sender skips 0-4
```

## Failure paths

| Situation           | Message                        | Who reacts                                 |
| ------------------- | ------------------------------ | ------------------------------------------ |
| Chunk hash mismatch | `RETRY { chunkIndex, reason }` | Sender resends that chunk                  |
| User pauses         | `PAUSE`                        | Other side stops sending, keeps state      |
| User resumes        | `RESUME { haveChunks }`        | Sender continues from the gaps             |
| User aborts         | `CANCEL { reason }`            | Both discard state                         |
| Connection drops    | _(no message)_                 | Both keep state; resume after reconnecting |

## Rules

1. **The receiver decides what it has.** The sender never assumes; it sends what `haveChunks` asks for.
2. **A chunk is only ACKed after its hash matches and it is stored.** An ACK means "durably mine", not "arrived".
3. **Nothing is trusted.** Indexes outside the manifest, chunks longer than the manifest says, or data before a `MANIFEST` are dropped, and the transfer fails loudly rather than crashing or filling storage.
4. **Backpressure is the sender's job.** Never send while `bufferedAmount` is above the high-water mark; wait for `bufferedamountlow`.
5. **Correctness lives here, not in the UI.** The UI only renders `TransferProgress`.
6. **`transferId` identifies the session; `fileId` identifies the content.** Resume matches on `fileId` plus `chunkSize`.

## Not in v0

- Encryption beyond DTLS (idea.md section 42.3)
- Multiple files or folders
- Multi-peer distribution
- Trickle ICE and automatic signaling (idea.md section 41)
