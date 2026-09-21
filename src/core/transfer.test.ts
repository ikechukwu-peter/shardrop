import { describe, it } from "vitest";

// A fake PeerSession (record what was sent, feed in what "arrives") keeps all
// of this testable without a browser. Only real WebRTC needs two tabs.
describe("send transfer", () => {
  it.todo("sends MANIFEST first and waits for READY");
  it.todo("skips chunks the receiver already has");
  it.todo("stops sending while bufferedAmount is above the high-water mark");
  it.todo("resumes sending on bufferedamountlow");
  it.todo("resends a chunk after RETRY");
  it.todo("fails the transfer after too many retries of one chunk");
  it.todo("sends COMPLETE only once every chunk is acknowledged");
  it.todo("stops sending on PAUSE and continues on RESUME");
});

describe("receive transfer", () => {
  it.todo("replies READY with the chunks already in the store");
  it.todo("assembles frames into a chunk before hashing");
  it.todo("stores and ACKs a chunk whose hash matches");
  it.todo("sends RETRY and stores nothing when the hash does not match");
  it.todo("ignores a chunk index outside the manifest");
  it.todo("ignores chunk data arriving before a MANIFEST");
  it.todo("rejects a chunk larger than the manifest promises");
  it.todo("finalizes and sends VERIFIED once nothing is missing");
  it.todo("asks for the gaps if COMPLETE arrives while chunks are missing");
});
