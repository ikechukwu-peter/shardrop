/**
 * Signaling relay.
 *
 * Two browsers cannot find each other on their own, so this passes offer and
 * answer between them. It is deliberately dumb:
 *
 *   - it never sees the file (that goes peer to peer over WebRTC)
 *   - it cannot read what it relays (payloads are encrypted with a key derived
 *     from the pairing code, which never reaches this server)
 *   - it stores nothing; a room exists only while both sockets are open
 *
 * Run: npm run signal
 */
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
/** Signaling envelopes are tiny; anything larger is not signaling. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_CAPACITY = 2;

/** room id → sockets */
const rooms = new Map();

const server = new WebSocketServer({ port: PORT });

server.on("connection", (socket, request) => {
  const room = new URL(request.url ?? "/", "http://localhost").searchParams.get(
    "room",
  );

  if (!room || room.length < 8 || room.length > 64) {
    socket.close(1008, "a room id of 8-64 characters is required");
    return;
  }

  const peers = rooms.get(room) ?? new Set();
  if (peers.size >= ROOM_CAPACITY) {
    socket.send(JSON.stringify({ relay: "full" }));
    socket.close(1013, "room full");
    return;
  }

  peers.add(socket);
  rooms.set(room, peers);

  if (peers.size === ROOM_CAPACITY) {
    // Both sides are here: the side that created the code starts the offer.
    for (const peer of peers) peer.send(JSON.stringify({ relay: "paired" }));
  }

  socket.on("message", (data, isBinary) => {
    if (isBinary) return; // signaling is text only
    const text = data.toString();
    if (text.length > MAX_MESSAGE_BYTES) return;
    for (const peer of peers) {
      if (peer !== socket && peer.readyState === 1) peer.send(text);
    }
  });

  socket.on("close", () => {
    peers.delete(socket);
    for (const peer of peers) {
      if (peer.readyState === 1) peer.send(JSON.stringify({ relay: "left" }));
    }
    if (peers.size === 0) rooms.delete(room);
  });
});

console.log(`signaling relay listening on ws://localhost:${PORT}`);
