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
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT ?? 8787);
/** Signaling envelopes are tiny; anything larger is not signaling. */
const MAX_MESSAGE_BYTES = 64 * 1024;
const ROOM_CAPACITY = 2;

/** room id → sockets */
const rooms = new Map();

/**
 * TURN credentials.
 *
 * A TURN relay is the only way to reach a peer behind carrier NAT, and its
 * credentials must not be long-lived secrets baked into the page. The long
 * key stays here; browsers ask for short-lived credentials over HTTPS.
 *
 * Two providers are supported, whichever is configured:
 *   Cloudflare  TURN_KEY_ID + TURN_KEY_API_TOKEN
 *   coturn      TURN_URL + TURN_SECRET   (static-auth-secret, TURN REST API)
 */
const TURN_TTL_SECONDS = 2 * 60 * 60;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "*")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

let turnCache = { expiresAt: 0, iceServers: [] };

async function iceServers() {
  if (Date.now() < turnCache.expiresAt) return turnCache.iceServers;

  const servers = (await cloudflareIceServers()) ?? coturnIceServers() ?? [];
  // Re-mint a little before expiry so a browser never gets a stale credential.
  turnCache = {
    iceServers: servers,
    expiresAt: servers.length
      ? Date.now() + (TURN_TTL_SECONDS - 300) * 1000
      : Date.now() + 60_000,
  };
  return servers;
}

async function cloudflareIceServers() {
  const keyId = process.env.TURN_KEY_ID;
  const token = process.env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return null;

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${keyId}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!response.ok) {
      console.warn(`cloudflare turn: HTTP ${response.status}`);
      return null;
    }
    const body = await response.json();
    return body.iceServers ?? null;
  } catch (error) {
    console.warn(`cloudflare turn: ${error.message}`);
    return null;
  }
}

/** The TURN REST API: username is an expiry, password an HMAC of it. */
function coturnIceServers() {
  const urls = process.env.TURN_URL;
  const secret = process.env.TURN_SECRET;
  if (!urls || !secret) return null;

  const username = `${Math.floor(Date.now() / 1000) + TURN_TTL_SECONDS}`;
  const credential = createHmac("sha1", secret)
    .update(username)
    .digest("base64");
  return [
    { urls: urls.split(",").map((url) => url.trim()), username, credential },
  ];
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const allowed =
    ALLOWED_ORIGINS.includes("*") ||
    (origin && ALLOWED_ORIGINS.includes(origin));
  return allowed
    ? { "access-control-allow-origin": origin ?? "*", vary: "origin" }
    : {};
}

// A plain HTTP server alongside, so a host's health check has something to
// call and the room count can be seen without attaching a client.
const http = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }

  if (request.url === "/turn") {
    // The page is served from another origin, so this needs CORS.
    const headers = {
      "content-type": "application/json",
      ...corsHeaders(request),
    };
    if (request.method === "OPTIONS") {
      response
        .writeHead(204, {
          ...headers,
          "access-control-allow-methods": "GET, OPTIONS",
        })
        .end();
      return;
    }
    void iceServers().then((servers) => {
      // Never cached by a CDN: these credentials expire.
      response.writeHead(200, { ...headers, "cache-control": "no-store" });
      response.end(JSON.stringify({ iceServers: servers }));
    });
    return;
  }

  response.writeHead(404).end();
});

const server = new WebSocketServer({ server: http });

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

  // A client that vanishes (closed tab, dropped Wi-Fi) surfaces as ECONNRESET
  // or EPIPE on its socket. Unhandled, an 'error' event takes the process
  // down, and one abandoned pairing would end everybody else's.
  socket.on("error", (error) => {
    console.warn(`socket error in room ${room}: ${error.message}`);
    socket.terminate();
  });

  socket.on("close", () => {
    peers.delete(socket);
    for (const peer of peers) {
      if (peer.readyState === 1) peer.send(JSON.stringify({ relay: "left" }));
    }
    if (peers.size === 0) rooms.delete(room);
  });
});

http.on("clientError", (error, socket) => {
  console.warn(`client error: ${error.message}`);
  socket.destroy();
});

server.on("error", (error) => {
  console.error(`websocket server error: ${error.message}`);
});

http.listen(PORT, () => {
  console.log(`signaling relay listening on port ${PORT}`);
});
