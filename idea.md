# Zendrop — Browser P2P File Transfer

## Serverless, Privacy-First, Chunk-Based File Transfer

### Project Vision

Build a browser application that allows two users to transfer files directly between their browsers.

The application should:

- Require no account
- Require no backend
- Require no database
- Require no cloud storage
- Never upload the file to a server
- Process files locally in the browser
- Split large files into chunks
- Transfer chunks peer-to-peer
- Verify chunks before reconstruction
- Reconstruct the original file on the receiving device
- Eventually support pause/resume and large files
- Prioritize privacy and local processing

The ultimate concept is:

```text
User A Browser
      │
      │
      │ File
      ▼
   Chunker
      │
      ▼
 Hash / Encrypt
      │
      ▼
 WebRTC DataChannel
      │
      │
      ▼
User B Browser
      │
      ▼
 Verify
      │
      ▼
 Reassemble
      │
      ▼
 Original File
```

The file should not pass through an application server.

---

# 1. The Most Important Constraint

## "No server" has two different meanings

There is an important distinction between:

### A. No file server

The file never touches your infrastructure.

This is relatively straightforward with WebRTC.

### B. Absolutely zero server/network infrastructure

No signaling server.

No STUN server.

No TURN server.

No cloud storage.

No backend whatsoever.

This is much harder.

A browser cannot magically discover another browser across the internet.

Therefore, the first version must use **manual signaling**.

For example:

```text
Browser A
   │
   │ generates WebRTC offer
   ▼
Copy text / QR code
   │
   │ manually transfer
   ▼
Browser B
   │
   │ generates answer
   ▼
Copy text / QR code
   │
   ▼
Browser A
```

The signaling information is not the file.

It is only connection metadata required to establish the peer connection.

---

# 2. What "Zero Server" Means for This Project

The initial project should have:

```text
NO
├── Node.js backend
├── NestJS backend
├── API
├── database
├── S3
├── Cloudinary
├── Firebase
├── Supabase
├── signaling server
├── TURN server
└── STUN server
```

Everything should happen locally.

The application can simply be a static website:

```text
HTML
CSS
JavaScript / TypeScript
Web APIs
WebRTC
IndexedDB
Web Workers
```

The static application itself can eventually be hosted somewhere, but hosting the application is different from using a server during the file transfer.

> **Update:** Strict zero-server only works reliably on the same local network. To connect people on **different networks** by scanning a QR code, Zendrop needs two small helpers that never see the file: a signaling relay and a STUN server. See **Section 41 — Connection Modes** for the revised definition.

---

# 3. Core Technology

Primary technologies:

### TypeScript

The entire application should be written in TypeScript.

### WebRTC

Use:

```text
RTCPeerConnection
RTCDataChannel
```

The DataChannel will carry file chunks.

### File API

Use:

```text
File
Blob
File.slice()
```

to access files without loading the entire file into memory.

### IndexedDB

Use IndexedDB for persistent local storage.

Potential uses:

- transfer state
- received chunks
- outgoing chunks
- metadata
- resumable transfers

### Web Workers

Use workers for expensive operations such as:

- hashing
- encryption
- potentially compression
- chunk processing

The main UI thread should remain responsive.

---

# 4. Architecture

The eventual architecture should look like:

```text
                 BROWSER A

              ┌─────────────┐
              │ File Picker │
              └──────┬──────┘
                     │
                     ▼
              ┌─────────────┐
              │ Chunk Engine│
              └──────┬──────┘
                     │
             ┌───────┴────────┐
             ▼                ▼
          Hashing          Encryption
             │                │
             └───────┬────────┘
                     ▼
              WebRTC DataChannel
                     │
                     │
              PEER-TO-PEER
                     │
                     ▼
              WebRTC DataChannel
                     │
              ┌──────┴──────┐
              ▼             ▼
           Verify        IndexedDB
              │
              ▼
          Reassemble
              │
              ▼
          File Output

                 BROWSER B
```

---

# 5. Phase 1 — Understand the Browser File API

Before touching WebRTC, understand how browsers handle files.

Build a tiny application where the user selects a file.

Display:

```text
Name
Size
Type
Last modified
```

Then experiment with:

```ts
file.slice(start, end);
```

Learn:

- Blob
- File
- ArrayBuffer
- Uint8Array
- DataView
- streams
- memory usage

Goal:

Understand how to work with a 5 GB file without doing:

```ts
await file.arrayBuffer();
```

on the entire file.

The application should process pieces instead.

---

# 6. Phase 2 — Build the Chunk Engine

Create:

```text
Chunker
```

Input:

```text
File
```

Output:

```text
Chunk[]
```

Conceptually:

```text
File
 │
 ├── Chunk 0
 ├── Chunk 1
 ├── Chunk 2
 ├── Chunk 3
 └── ...
```

Each chunk should contain metadata such as:

```ts
type FileChunk = {
  index: number;
  offset: number;
  size: number;
  data: Blob;
};
```

Do not keep every chunk in memory.

Process them progressively.

---

# 7. Phase 3 — Hashing

Give every chunk an integrity hash.

Example:

```text
Chunk 0 → SHA-256 → abc123...
Chunk 1 → SHA-256 → 72fe91...
Chunk 2 → SHA-256 → 91ac72...
```

Metadata:

```ts
type ChunkMetadata = {
  index: number;
  size: number;
  hash: string;
};
```

The receiver can calculate the hash again.

```text
Sender hash
     │
     ▼
abc123

Receiver hash
     │
     ▼
abc123

        ✓ VALID
```

If they differ:

```text
Expected: abc123
Received: xyz999

        ✕ CORRUPTED
```

The chunk can then be retransmitted.

---

# 8. Phase 4 — Build the File Manifest

Before transferring the actual file, create a manifest.

Example:

```ts
type FileManifest = {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  chunkSize: number;
  totalChunks: number;
  chunks: {
    index: number;
    size: number;
    hash: string;
  }[];
};
```

Conceptually:

```text
FILE
├── name: movie.mp4
├── size: 4.7 GB
├── chunkSize: 10 MB
├── totalChunks: 481
│
├── chunk 0
│   └── hash
│
├── chunk 1
│   └── hash
│
└── ...
```

The receiver can know exactly what is expected before the transfer begins.

---

# 9. Phase 5 — Learn WebRTC Without Files

Do NOT immediately try to transfer a 5 GB video.

First build:

```text
Browser A ←──── WebRTC ────→ Browser B
```

and send:

```text
Hello from Browser A
```

Use:

```text
RTCPeerConnection
RTCDataChannel
```

Understand:

- offer
- answer
- ICE candidates
- connection states
- data channels
- open
- message
- close
- errors

---

# 10. Phase 6 — Manual Signaling

Because the project requires zero servers, implement manual signaling.

Sender:

```text
Create Offer
     ↓
Generate SDP
     ↓
Show QR / Copy
```

Receiver:

```text
Paste / Scan Offer
     ↓
Create Answer
     ↓
Show QR / Copy
```

Then:

```text
Answer
  ↓
Sender
  ↓
Connection
```

A future UI might look like:

```text
SEND FILE

Step 1
Create connection

[ Generate Connection Code ]

Step 2
Send this code to receiver

┌─────────────────────────┐
│ A7F2...                 │
│                         │
└─────────────────────────┘

[ Copy ] [ Show QR ]
```

Receiver:

```text
RECEIVE FILE

Paste sender code:

[____________________]

[ Connect ]
```

Eventually QR codes can make the process easier.

Important:

The QR/code carries **signaling information**, not the file.

> **Note:** Manual signaling needs **two** exchanges (offer → answer) and, without STUN, usually only works on the same network. The one-scan QR flow that works across networks is described in **Section 41**.

---

# 11. Phase 7 — Transfer a Small File

Start with:

```text
hello.txt
```

Then:

```text
100 KB
1 MB
10 MB
100 MB
```

Only after those work should you move toward multi-gigabyte files.

Basic flow:

```text
File
 ↓
slice
 ↓
ArrayBuffer
 ↓
DataChannel.send()
 ↓
Receiver
 ↓
Blob
 ↓
Download
```

---

# 12. Phase 8 — Introduce Real Chunking

Now transfer:

```text
10 MB
```

as:

```text
1 MB × 10 chunks
```

Then:

```text
500 MB
```

as:

```text
5 MB × 100 chunks
```

Then test larger files.

Never assume:

```text
DataChannel.send(entireFile)
```

is appropriate.

The application needs controlled chunk transmission.

---

# 13. Phase 9 — Backpressure

This is extremely important.

Do not blindly do:

```ts
for (...) {
  channel.send(chunk);
}
```

You can overwhelm the DataChannel/browser buffers.

Learn and use:

```text
bufferedAmount
bufferedAmountLowThreshold
bufferedamountlow
```

Conceptually:

```text
              Sender

Chunk
  ↓
DataChannel
  ↓
Buffer
  ↓
Network
```

If the buffer gets too large:

```text
PAUSE
```

When the buffer drains:

```text
RESUME
```

This becomes your first real concurrency/networking challenge.

---

# 14. Phase 10 — Transfer Protocol

Create your own small protocol.

For example:

```text
MANIFEST
CHUNK
ACK
RETRY
PAUSE
RESUME
COMPLETE
CANCEL
```

Conceptually:

```text
Sender → MANIFEST
Receiver → READY

Sender → CHUNK 0
Receiver → ACK 0

Sender → CHUNK 1
Receiver → ACK 1

...

Sender → COMPLETE
Receiver → VERIFIED
```

Do not rely on the UI to represent protocol state.

The protocol should have explicit states.

---

# 15. Phase 11 — Reliable Chunk Verification

Each chunk:

```text
chunk data
   ↓
SHA-256
   ↓
hash
```

Receiver:

```text
received data
   ↓
SHA-256
   ↓
compare
```

If valid:

```text
ACK
```

If invalid:

```text
RETRY
```

This gives the project a real integrity layer.

---

# 16. Phase 12 — IndexedDB

Now introduce persistent local storage.

Instead of:

```text
received chunk
     ↓
RAM
```

use:

```text
received chunk
     ↓
IndexedDB
```

Store:

```text
Transfer
├── transfer ID
├── file metadata
├── manifest
├── status
└── chunks
```

This makes larger transfers much more practical.

It also creates the foundation for resumability.

---

# 17. Phase 13 — Pause and Resume

User clicks:

```text
PAUSE
```

Transfer:

```text
001 ✓
002 ✓
003 ✓
004 ✓
005 ✓
006 ⏸
007
008
...
```

Later:

```text
RESUME
```

The sender and receiver determine:

```text
Which chunks already exist?
Which chunks are missing?
Which chunks need verification?
```

Then continue.

The transfer should NOT restart from zero.

---

# 18. Phase 14 — Connection Recovery

Eventually test:

```text
Transfer 73%
       ↓
Internet/Wi-Fi interruption
       ↓
Connection lost
```

The application should preserve:

```text
Transfer ID
Manifest
Completed chunks
Hashes
Progress
```

When a new connection is established:

```text
Resume from known state
```

This is one of the hardest and most valuable parts of the project.

---

# 19. Phase 15 — Encryption

WebRTC already provides encrypted transport, but you can add application-level encryption.

Use the Web Crypto API.

Conceptually:

```text
Original chunk
      ↓
Encrypt
      ↓
Encrypted chunk
      ↓
WebRTC
      ↓
Decrypt
      ↓
Verify
```

Never invent your own cryptographic algorithm.

Use established browser cryptography primitives.

Potential technologies to investigate:

```text
Web Crypto API
AES-GCM
SHA-256
HKDF
```

The encryption key should never be sent to a server.

---

# 20. Phase 16 — Web Workers

Move expensive operations away from the main thread.

Main thread:

```text
UI
 │
 ├── progress
 ├── controls
 └── connection
```

Worker:

```text
Hash
Encrypt
Process chunks
```

Architecture:

```text
Main Thread
     │
     │ postMessage
     ▼
Web Worker
     │
     ├── hash
     ├── encrypt
     └── process
     │
     ▼
Main Thread
```

The UI should remain responsive even during large transfers.

---

# 21. Phase 17 — Multiple Chunks In Flight

Eventually experiment with controlled parallelism.

For example:

```text
Window = 5

Chunk 100 ──→
Chunk 101 ──→
Chunk 102 ──→
Chunk 103 ──→
Chunk 104 ──→
```

As chunks complete:

```text
105 ──→
106 ──→
```

But this must be controlled by backpressure.

Do not simply maximize concurrency.

Measure it.

---

# 22. Phase 18 — Build the Beautiful UI

Only after the protocol works should you build the polished interface.

Sender:

```text
┌──────────────────────────────────────┐
│             SEND FILE                │
│                                      │
│          Drop file here              │
│                                      │
│          movie.mp4                   │
│          4.7 GB                      │
│                                      │
│       Connecting...                  │
│                                      │
│       ████████████░░░░  73%          │
│                                      │
│       38.4 MB/s                      │
│       1m 12s remaining               │
│                                      │
│       Chunks: 351 / 481              │
│                                      │
│       [ Pause ] [ Cancel ]           │
└──────────────────────────────────────┘
```

Receiver:

```text
┌──────────────────────────────────────┐
│            RECEIVE FILE              │
│                                      │
│          movie.mp4                   │
│          4.7 GB                      │
│                                      │
│       ███████████████░  92%           │
│                                      │
│       4.3 GB received                │
│                                      │
│       Integrity: ✓                   │
│       Connection: Direct             │
│                                      │
│       [ Save File ]                  │
└──────────────────────────────────────┘
```

---

# 23. Important Browser Constraints

The browser is NOT a native file-transfer application.

Expect limitations.

### Browser memory

Do not load huge files completely into memory.

Bad:

```ts
const buffer = await file.arrayBuffer();
```

for a multi-gigabyte file.

Prefer:

```text
slice
→ process
→ transfer
→ discard
```

or persistent storage.

### Browser storage quotas

IndexedDB storage limits vary by browser and device.

Do not assume you can store unlimited data.

### Browser compatibility

WebRTC and related APIs behave differently across browsers.

Test at minimum:

```text
Chrome
Firefox
Safari
Edge
```

especially if you want cross-platform support.

### Background behavior

Browsers may throttle or suspend tabs.

Do not assume a transfer can run indefinitely while the page is hidden.

### Mobile browsers

Mobile browsers impose additional restrictions around memory, background execution, battery, and storage.

A desktop-first MVP is sensible.

---

# 24. The Biggest Zero-Server Limitation

Without STUN/TURN:

```text
Browser A
    │
    │
    X
    │
Browser B
```

may fail when the users are behind different NATs/firewalls.

Direct connectivity is easiest when:

```text
Same local network
```

or when the network environment permits host-to-host connectivity.

Across arbitrary internet connections, you cannot promise direct connectivity with absolutely zero infrastructure.

Therefore the product must clearly distinguish:

```text
Direct connection
```

from:

```text
Relay connection
```

The strict version of this project should refuse to silently fall back to a server.

---

# 25. LAN Mode

This should become an important feature.

If two devices are on the same Wi-Fi network:

```text
Laptop
   │
   │
 Wi-Fi
   │
   ▼
Phone
```

you can investigate whether direct local connectivity can be established.

This is where the application begins to feel like:

```text
AirDrop
Xender
SHAREit
```

but implemented primarily with web technologies.

However, browser security restrictions mean that a web app cannot assume access to every native local-network discovery mechanism.

Do not promise "works offline everywhere."

---

# 26. What "Offline" Should Mean

Define this carefully.

### Internet unavailable, same local network

Potentially possible depending on the networking/browser situation.

### Completely disconnected devices

No.

Two browsers cannot exchange data if there is no communication path between the devices.

### Internet unavailable and devices can communicate locally

Potentially possible, but browser support and discovery mechanisms become the limiting factor.

### Devices on completely different networks with no server infrastructure

Not reliably possible.

---

# 27. Security Threat Model

Eventually investigate:

### File authenticity

Can the receiver trust that the file came from the intended sender?

### Connection authentication

Can another person inject themselves into the transfer?

### Replay attacks

Can old transfer messages be reused?

### Malicious files

Your application should treat received files as untrusted data.

### Denial of service

A malicious peer could attempt to send enormous amounts of data.

### Storage exhaustion

A malicious transfer could fill IndexedDB.

Set limits.

### Resource exhaustion

Do not allow unbounded:

```text
chunks
buffers
workers
retries
```

---

# 28. Do Not Build These Too Early

Avoid immediately adding:

- accounts
- authentication servers
- databases
- S3
- Redis
- NestJS
- Kubernetes
- microservices
- cloud storage
- analytics

Those would defeat the purpose of the initial experiment.

The interesting engineering challenge is:

```text
Browser
+
WebRTC
+
Chunking
+
Storage
+
Cryptography
+
Networking
```

---

# 29. Suggested Repository Structure

Eventually:

```text
zendrop/
│
├── apps/
│   └── web/
│
├── packages/
│   ├── chunk-engine/
│   ├── transfer-protocol/
│   ├── hashing/
│   ├── crypto/
│   ├── storage/
│   └── webrtc/
│
├── tests/
│
└── docs/
```

For the first prototype, however, keep it much simpler.

Do not over-engineer before the protocol works.

---

# 30. Suggested Internal Modules

Eventually separate:

```text
FileReader
Chunker
ManifestBuilder
Hasher
Encryptor
ChunkStore
TransferProtocol
PeerConnection
DataChannelManager
TransferManager
TransferRecovery
FileAssembler
```

A high-level flow:

```text
TransferManager
      │
      ├── FileReader
      ├── Chunker
      ├── Hasher
      ├── Encryptor
      ├── ChunkStore
      └── PeerConnection
```

---

# 31. Development Milestones

## Milestone 1

Select a file.

Display metadata.

---

## Milestone 2

Split file into chunks.

---

## Milestone 3

Hash chunks.

---

## Milestone 4

Create file manifest.

---

## Milestone 5

Establish WebRTC connection manually.

---

## Milestone 6

Send a text message through DataChannel.

---

## Milestone 6b

QR Connect: one scan pairs two devices on different networks via a signaling relay + STUN (Section 41).

---

## Milestone 7

Send a small file.

---

## Milestone 8

Send files using chunks.

---

## Milestone 9

Implement backpressure.

---

## Milestone 10

Implement ACK/retry.

---

## Milestone 11

Add IndexedDB.

---

## Milestone 12

Add pause/resume.

---

## Milestone 13

Add connection recovery.

---

## Milestone 14

Add encryption.

---

## Milestone 15

Move hashing/encryption to Web Workers.

---

## Milestone 16

Optimize large files.

---

## Milestone 17

Build polished UI.

---

## Milestone 18

Test across browsers and networks.

---

# 32. Testing Matrix

Do not only test:

```text
Chrome → Chrome
```

Test:

```text
Chrome → Firefox
Chrome → Safari
Firefox → Chrome
Safari → Chrome
Safari → Safari
```

And:

```text
same Wi-Fi
different Wi-Fi
mobile hotspot
slow network
connection interruption
browser refresh
tab backgrounded
large files
many chunks
corrupted chunks
insufficient storage
cancelled transfers
```

---

# 33. Performance Metrics

Track:

```text
File size
Chunk size
Chunks transferred
Transfer speed
Time elapsed
Time remaining
Retries
Failed chunks
Buffered bytes
Hashing time
Encryption time
Assembly time
Memory usage
```

This turns the project from a toy into an actual networking experiment.

---

# 34. Things to Experiment With

### Chunk sizes

Compare:

```text
256 KB
512 KB
1 MB
5 MB
10 MB
25 MB
50 MB
```

Measure:

```text
speed
memory
CPU
retries
latency
```

### Concurrency/window size

Compare:

```text
1
2
4
8
16
```

### Hashing

Measure hashing overhead.

### Encryption

Measure encryption overhead.

### IndexedDB

Measure storage performance.

This will teach you considerably more than simply implementing a library.

---

# 35. The Ultimate Architecture

If the project eventually reaches its full form:

```text
                 STATIC WEB APP
                       │
                       ▼
                ┌──────────────┐
                │ File Manager │
                └──────┬───────┘
                       │
                       ▼
                ┌──────────────┐
                │ Chunk Engine │
                └──────┬───────┘
                       │
              ┌────────┼─────────┐
              ▼        ▼         ▼
           Hashing  Encryption  Storage
              │        │         │
              └────────┼─────────┘
                       ▼
                Transfer Engine
                       │
                       ▼
                WebRTC DataChannel
                       │
                       │
                DIRECT CONNECTION
                       │
                       ▼
                WebRTC DataChannel
                       │
                       ▼
                Transfer Engine
                       │
              ┌────────┼─────────┐
              ▼        ▼         ▼
           Verify    Storage   Recovery
                       │
                       ▼
                  Reassemble
                       │
                       ▼
                   File
```

No application server needs to handle the file.

---

# 36. The Final Product Concept

The final experience should feel like:

> **Drop. Connect. Transfer. Done.**

No account.

No upload.

No cloud storage.

No permanent copy.

No application server receiving the file.

The sender and receiver establish a peer connection and transfer the file directly whenever the network environment allows it.

---

# 37. What This Project Teaches

This project is valuable because it touches several areas of real engineering:

### Browser internals

```text
File API
Blob
Streams
IndexedDB
Workers
```

### Networking

```text
WebRTC
DataChannels
NAT
ICE
connection recovery
backpressure
```

### Distributed systems

```text
peer-to-peer communication
failure recovery
partial state
retries
protocol design
```

### Cryptography

```text
hashing
integrity
encryption
key management
```

### Systems design

```text
chunking
storage
memory management
concurrency
performance
```

---

# 38. Rules to Remember

Keep these rules visible throughout development:

1. **Never load an enormous file entirely into memory unnecessarily.**
2. **Never assume a WebRTC connection means a direct physical path.**
3. **Never assume two arbitrary browsers can connect without NAT traversal infrastructure.**
4. **Never claim "zero server" while secretly using STUN/TURN/signaling infrastructure.**
5. **Never send unlimited DataChannel data without backpressure.**
6. **Never trust received chunks without verification.**
7. **Never assume IndexedDB can store unlimited data.**
8. **Never make the UI responsible for transfer correctness.**
9. **Treat the transfer protocol as its own system.**
10. **Start with tiny files and progressively test larger ones.**
11. **Build the protocol before polishing the UI.**
12. **Measure performance rather than guessing.**
13. **Test across browsers and network conditions.**
14. **Separate "no file server" from "no infrastructure whatsoever."**
15. **For the strict serverless version, use manual signaling and understand that arbitrary internet-to-internet connectivity cannot be guaranteed.**

---

# 39. Future Possibilities

Once the core system works, possible extensions include:

```text
P2P folders
P2P video streaming
P2P clipboard transfer
P2P text sharing
P2P photo sharing
P2P backup
P2P synchronization
LAN mode
QR pairing
encrypted transfers
file deduplication
chunk-level versioning
multi-peer distribution
```

A particularly interesting future experiment:

```text
                    FILE
                     │
              ┌──────┼──────┐
              ▼      ▼      ▼
            Peer A  Peer B  Peer C
              │      │      │
              └──────┼──────┘
                     ▼
                  Receiver
```

That moves the project from simple P2P transfer toward **distributed file distribution**.

---

# 40. Final Project Definition

### Name

**Zendrop**

> Note: "Zendrop" is already used by an existing dropshipping company (zendrop.com). Fine for a learning project; reconsider before publishing publicly.

### One-line description

> A privacy-first browser application for transferring large files directly between peers using chunked WebRTC data transfer, with no cloud storage and no server ever seeing the file.

### Core principle

```text
Your file belongs to you.

It should not need to visit our server
just because you want to send it to another person.
```

### MVP

```text
Browser A
   │
   │ manual signaling
   ▼
Browser B
   │
   │ WebRTC
   ▼
chunked file transfer
   │
   ▼
verify
   │
   ▼
reconstruct
```

### Full version

```text
P2P
+
Chunking
+
Hashing
+
Encryption
+
Backpressure
+
IndexedDB
+
Resume
+
Recovery
+
Web Workers
+
QR pairing
+
LAN experimentation
```

---

# 41. Connection Modes — QR Connect Across Networks

## The requirement

> Scan one QR code and connect — even when the two people are on **different networks**.

This changes the "zero server" definition from Sections 1–2. Two browsers on different networks cannot find each other on their own. Every product that does this (Snapdrop/PairDrop, ShareDrop, FilePizza, Wormhole) uses small helper services.

The principle becomes:

```text
No server ever sees the file.
Servers may only help two browsers find each other.
```

## The three helpers

| Helper          | What it does                                                  | Sees the file?                      | Required?                   |
| --------------- | ------------------------------------------------------------- | ----------------------------------- | --------------------------- |
| Signaling relay | Passes the offer/answer/ICE messages between the two browsers | No                                  | Yes, for one-scan QR        |
| STUN server     | Tells a browser its public IP:port so the peer can reach it   | No                                  | Yes, for different networks |
| TURN server     | Relays traffic when a direct connection is impossible         | Only encrypted bytes it cannot read | Optional, see below         |

### Why one scan needs a signaling relay

WebRTC needs a **two-way** exchange: the offer goes A → B and the answer goes B → A. A QR code only goes one way. With one scan, the answer (and ICE candidates) must come back over some channel, and that channel is the signaling relay.

Without a relay you would need two scans (A shows a QR code, B scans it; B shows a QR code, A scans it). That only works when both people are in the same room, and both devices need cameras.

## The QR Connect flow

```text
Sender (Browser A)                      Receiver (Browser B)
──────────────────                      ────────────────────
1. Generate:
   roomId  (random, 128-bit)
   secret  (random, 256-bit)

2. Show QR:
   https://zendrop.app/#r=<roomId>&k=<secret>
                    │
                    │  scan with phone camera
                    ▼
                                        3. Page opens, reads the
                                           fragment (#...) locally

4. Both join room <roomId> on the signaling relay
                    │
5. Exchange offer / answer / ICE candidates
   (each message encrypted with <secret>)
                    │
6. STUN discovers public addresses
                    │
7. ICE tries candidate pairs → direct connection
   (if it fails and TURN is enabled → relayed connection)
                    │
8. Signaling relay is no longer needed. Disconnect from it.
                    │
9. File chunks flow directly A ⇄ B over the DataChannel
```

### Why the secret goes in the URL fragment

The part after `#` is **never sent to any server** by the browser. The relay only ever sees `roomId`. The secret is shared only between the two devices, through the QR code.

### Don't trust the signaling relay

The SDP contains the peer's **DTLS certificate fingerprint**, and that fingerprint is what authenticates the encrypted WebRTC connection. A malicious relay could swap the SDPs and sit in the middle.

Defense: encrypt and authenticate every signaling message with AES-GCM, using a key derived from the QR `secret` (via HKDF). The relay then just passes along bytes it cannot read or forge. Anyone who didn't scan the QR code cannot join.

Bonus: show a short verification code (for example, 4 emoji derived from both fingerprints) on both screens so the users can compare them.

### Short-code fallback

A QR code works when the receiver has a camera (laptop → phone). For phone → laptop, or for remote users, also offer a short human-typeable code such as `7-tiger-canyon`. Study **magic-wormhole** and **PAKE** (password-authenticated key exchange) to understand how a short code can still give strong security. This is advanced, so do it later.

## Different networks: what to expect

```text
Same Wi-Fi                  → host candidates, works without STUN
Home ↔ home (typical NAT)   → STUN usually succeeds
Mobile data (CGNAT)         → often fails without TURN
Corporate / university      → often fails without TURN (UDP blocked)
Symmetric NAT on both sides → needs TURN
```

Rough intuition: STUN alone connects the majority of cross-network pairs, but a meaningful minority (especially mobile carriers and strict firewalls) **need TURN**. Measure this yourself; don't rely on internet folklore.

## The TURN decision

To work **reliably** across networks, you need TURN. That is a real trade-off:

- **Without TURN:** zero relay infrastructure, but some connections simply fail. Show a clear error: "Direct connection not possible on this network."
- **With TURN:** it works almost everywhere, but traffic passes through a relay and bandwidth costs money. The relay still can't read the file (DTLS, plus optional app-level encryption from Phase 15).

Recommended: make TURN **opt-in and visible**. Always show the connection type:

```text
Connection: Direct ✓
Connection: Relayed (encrypted, via TURN)
```

Detect it with `pc.getStats()` → selected candidate pair → `candidateType === "relay"`.

This keeps Rule 4 honest: never silently use a relay.

## Implementation options for the signaling relay

The signaling relay is tiny. It only forwards small messages between two sockets in the same room and keeps no data.

1. **Write your own** (recommended for learning): a WebSocket server with rooms of 2, about 50–100 lines. Host it on a small VM, Fly.io, or Cloudflare Workers + Durable Objects. Delete a room as soon as pairing finishes or after a short timeout.
2. **Reuse public infrastructure**: a PeerJS server, public MQTT brokers, Nostr relays, or BitTorrent trackers (the library **Trystero** does this). This needs no server of your own, but you depend on someone else's service.

STUN: public servers exist (for example `stun:stun.l.google.com:19302`, `stun:stun.cloudflare.com:3478`) or self-host with **coturn**.

TURN: self-host **coturn**, or use a hosted TURN provider. Never put long-lived TURN credentials in client code; generate short-lived credentials.

## Revised modes

```text
Mode A — LAN / Strict
  Manual or QR signaling, no STUN/TURN.
  Same network only. Zero infrastructure.

Mode B — QR Connect (default)
  Signaling relay + STUN.
  Works across most networks. No server sees the file.

Mode C — QR Connect + Relay (opt-in)
  Adds TURN. Works almost everywhere.
  Relay carries encrypted bytes only. Clearly labeled.
```

## Revised architecture (connection setup only)

```text
Browser A ──ws──► Signaling Relay ◄──ws── Browser B     (tiny encrypted messages)
    │                                         │
    └──────► STUN ◄───────────────────────────┘          (address discovery)

Browser A ◄════════ WebRTC DataChannel ════════► Browser B   (the file)
                 (or via TURN if opted in)
```

---

# 42. Technical Notes From Design Review

Corrections and refinements to the phases above.

## 42.1 Logical chunk ≠ wire message

A single DataChannel message is limited to about 256 KB in practice, and about 64 KB is the safe cross-browser size. Check `pc.sctp.maxMessageSize`.

Use two layers:

```text
Logical chunk (1–10 MB)  → unit of hashing, storage, resume
   └── Wire frames (≤64 KB) → unit of DataChannel.send()
```

The chunk-size experiments in Section 34 apply to **logical chunks**. Frame size is a separate, smaller setting.

## 42.2 The DataChannel is already reliable and ordered

By default, a DataChannel (SCTP over DTLS) already guarantees delivery, order, integrity, and encryption.

- Per-chunk SHA-256 does **not** catch network corruption, because that can't happen here. It catches **your own bugs**, bad data after a resume, and chunks read back from storage. Still worth doing.
- ACK/RETRY repeats what the transport already does. Its real value is **application-level progress**: knowing which chunks are safely stored on the receiver, which is what makes resume work.
- If the sender waits for each ACK before sending the next chunk, throughput collapses on slow links. Learn about the **bandwidth-delay product**.
- Phase 17's window size on a single channel doesn't send anything at the same time; it only keeps the pipe full. Measure whether multiple channels help. Often they don't.

## 42.3 Encryption: authentication matters more

WebRTC is always encrypted. The real question is **who you are connected to**. The DTLS fingerprint in the SDP is the identity, so protect the signaling path (Section 41) and add a verification code. App-level AES-GCM (Phase 15) matters mainly when TURN relays are used, or for defense in depth.

## 42.4 Prefer OPFS over IndexedDB for file data

The **Origin Private File System** (`navigator.storage.getDirectory()`) works in Chrome, Firefox, and Safari.

- Write each chunk at its exact position in a real file (`createSyncAccessHandle()` in a worker).
- Resume = check which chunks are missing.
- At the end, `getFile()` returns the whole file without loading it into memory.

Use IndexedDB only for small state: the manifest, transfer status, and the list of completed chunks. On Chromium, `showSaveFilePicker()` can also write straight to the user's disk.

Also call `navigator.storage.persist()` and check `navigator.storage.estimate()` before accepting a transfer.

## 42.5 Hashing the whole file upfront is expensive

Hashing every chunk for the manifest means reading the entire file once before sending anything, which can take tens of seconds for 5 GB. Also, `crypto.subtle.digest` can't hash data piece by piece, so a whole-file hash needs a library such as `hash-wasm`.

Options:

- Hash each chunk just before it is sent; include the hash in the chunk header.
- Use a **Merkle tree** (as BitTorrent v2 and IPFS do): the root hash identifies the file, and each chunk can be verified independently.

## 42.6 Manual signaling details

- Without STUN, browsers hide local IPs behind random mDNS names (`xxxx.local`). This usually works on the same LAN, but some networks block mDNS.
- For copy/QR signaling, wait for ICE gathering to finish (`iceGatheringState === "complete"`) before showing the code. The SDP is 1–3 KB, which gives a dense QR code. Strip unnecessary SDP lines or compress it.

## 42.7 Scope

- **v0.1 = Milestone 9** (backpressure working). Everything after is an extra.
- Do a WebRTC "hello" spike early (around Milestone 2). It is the riskiest unknown, so hit its problems first.
- Build QR Connect (Milestone 6b) before large-file work if cross-network use is the main goal.
