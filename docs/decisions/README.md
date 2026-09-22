# Design decisions

One file per decision, e.g. `001-opfs-over-indexeddb.md`:

- **Context:** what problem forced a choice
- **Options:** what was considered
- **Decision:** what was chosen and why
- **Consequences:** what it costs, what to revisit

## Index

- [001 — Deriving the fileId from chunk hashes](001-file-id.md)
- [002 — OPFS for received chunks, not IndexedDB](002-opfs.md)
- [003 — One pairing code that is also the encryption key](003-signaling.md)
- [004 — Folders as a sequence of files, not a new format](004-batches.md)
- [005 — Hashing in a worker, on the evidence](005-hash-worker.md)
- [006 — TURN credentials from the relay, and a relay you only need for a moment](006-turn-and-relay-lifecycle.md)
