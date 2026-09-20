# 001 — Deriving the fileId from chunk hashes

## Context

A manifest needs two different identifiers:

- `transferId` — identifies one transfer session between two peers. A random UUID is enough.
- `fileId` — identifies the _content_. Resume, deduplication and "do I already have this file?" all need the same bytes to produce the same id every time, on both sides.

This decision is about the `fileId`.

## Options

**A. Streaming whole-file SHA-256.** Feed chunks one at a time into an incremental hasher; memory stays at one chunk. Produces a standard SHA-256 that matches `shasum` on the same file, and does not depend on the chunk size. But `crypto.subtle.digest` cannot hash data piece by piece, so this needs an extra dependency (`hash-wasm`).

**B. Hash of the chunk hashes.** `fileId = SHA-256(chunkSize + "\n" + chunkHashes.join(""))`. The chunk hashes are already computed while building the manifest, so this adds one small hash over a short string.

**C. Metadata fingerprint** (name + size + lastModified). Cheap, but not derived from the content: two different files can collide, and a renamed file changes id. Only usable as a local cache key.

## Decision

Option B.

- The chunk hashes already exist, so the id costs one extra hash of a short string, with no second pass over the file.
- It stays inside Web Crypto, so no extra dependency.
- It is the first step toward a Merkle tree: that "hash of hashes" becomes the root, which later lets a receiver verify any single chunk on its own without holding the whole file.

Memory was not the deciding factor — option A never loads the whole file either.

## Consequences

- **The id depends on the chunk size.** The same file chunked at 20 bytes and at 50 bytes produces different `fileId`s. `chunkSize` is therefore part of the hashed input, so the dependency is explicit rather than hidden. Pinned by a test in `src/core/manifest.test.ts`.
- Resume across sessions only works when both sides use the same chunk size. If chunk size ever becomes adjustable, either pin a canonical size for identity (for example 1 MiB) or treat `(fileId, chunkSize)` as the key.
- The `fileId` does not match `shasum` output for the same file, so it cannot be compared against hashes computed elsewhere.
- Revisit when the Merkle tree lands: the root hash should then replace this construction.
