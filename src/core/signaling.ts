/**
 * Pairing over a signaling relay.
 *
 * One short code does two jobs: it names the relay room, and it is the key
 * material that encrypts everything sent through the relay. Both are derived
 * from it with HKDF, so the relay learns only a room id it cannot reverse, and
 * cannot read or forge the offers it passes along.
 *
 * That matters because the SDP carries the DTLS fingerprint. A relay able to
 * swap fingerprints could put itself in the middle of the "direct" connection
 * (idea.md section 42.3). Encrypting with a code that never reaches the relay
 * removes it from the trusted path: whoever has the code, and only they, can
 * pair.
 *
 * The code travels in a URL fragment (#c=…), which browsers never send to a
 * server.
 */

/** Crockford base32: no I, L, O or U, so codes are safe to read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_CHARS = 16; // 16 × 5 bits = 80 bits of entropy
const HKDF_SALT = "shardrop-signaling-v0";
/** How long to wait for the relay before saying it cannot be reached. */
export const RELAY_CONNECT_TIMEOUT_MS = 10_000;

export type SignalingMessage =
  { type: "offer"; sdp: string } | { type: "answer"; sdp: string };

export function createPairingCode(): string {
  const bytes = new Uint8Array(10); // 80 bits
  crypto.getRandomValues(bytes);

  let bits = 0;
  let value = 0;
  let code = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      code += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return group(code);
}

/** Strips formatting so "abcd-efgh" and "ABCDEFGH" are the same code. */
export function normalizePairingCode(code: string): string {
  const cleaned = code.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (cleaned.length !== CODE_CHARS) {
    throw new Error(`a pairing code has ${CODE_CHARS} characters`);
  }
  return cleaned;
}

function group(code: string): string {
  return (code.match(/.{1,4}/g) ?? []).join("-");
}

export function formatPairingCode(code: string): string {
  return group(normalizePairingCode(code));
}

export function pairingCodeFromUrl(href: string): string | null {
  const hash = href.includes("#") ? href.slice(href.indexOf("#") + 1) : "";
  const code = new URLSearchParams(hash).get("c");
  if (!code) return null;
  try {
    return normalizePairingCode(code);
  } catch {
    return null;
  }
}

export function pairingUrl(code: string, href: string): string {
  const url = new URL(href);
  url.hash = `c=${normalizePairingCode(code)}`;
  return url.toString();
}

/** Room id and encryption key, both derived from the code and nothing else. */
export async function deriveSignalingSecrets(
  code: string,
): Promise<{ roomId: string; key: CryptoKey }> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(normalizePairingCode(code)),
    "HKDF",
    false,
    ["deriveBits", "deriveKey"],
  );
  const params = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new TextEncoder().encode(HKDF_SALT),
    info: new TextEncoder().encode(info),
  });

  const roomBits = await crypto.subtle.deriveBits(
    params("room"),
    material,
    128,
  );
  const key = await crypto.subtle.deriveKey(
    params("aes-gcm-key"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );

  return { roomId: toHex(roomBits), key };
}

export async function sealMessage(
  key: CryptoKey,
  message: SignalingMessage,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(message)),
  );
  return `${toBase64(iv.buffer)}.${toBase64(ciphertext)}`;
}

/** Throws if the payload was tampered with: AES-GCM authenticates as well. */
export async function openMessage(
  key: CryptoKey,
  sealed: string,
): Promise<SignalingMessage> {
  const [ivPart, bodyPart] = sealed.split(".");
  if (!ivPart || !bodyPart) throw new Error("malformed signaling envelope");

  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(fromBase64(ivPart)) },
    key,
    fromBase64(bodyPart),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !["offer", "answer"].includes(String((parsed as { type?: unknown }).type))
  ) {
    throw new Error("unexpected signaling message");
  }
  return parsed as SignalingMessage;
}

/**
 * Where the relay lives.
 *
 * By default it is this same origin under /signal, which Vite proxies to the
 * local relay in development, so no second port is configured anywhere.
 * Deployments set VITE_SIGNAL_URL to the real relay.
 */
export function defaultRelayUrl(): string {
  const configured = import.meta.env["VITE_SIGNAL_URL"];
  if (typeof configured === "string" && configured) return configured;
  const secure = location.protocol === "https:";
  return `${secure ? "wss" : "ws"}://${location.host}/signal`;
}

/** The relay's HTTP address, for the endpoints that are not the socket. */
export function relayHttpUrl(path: string): string {
  const url = new URL(defaultRelayUrl());
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.search = "";
  url.hash = "";
  url.pathname = path;
  return url.toString();
}

/** A pairing session on the relay: encrypted in, encrypted out. */
export class SignalingChannel {
  private pairedListener?: () => void;
  private messageListener?: (message: SignalingMessage) => void;
  private errorListener?: (error: string) => void;

  private constructor(
    private readonly socket: WebSocket,
    private readonly key: CryptoKey,
    readonly code: string,
  ) {
    socket.addEventListener("message", (event) => {
      void this.receive(String(event.data));
    });
  }

  static async join(
    code: string,
    relayUrl?: string,
  ): Promise<SignalingChannel> {
    const { roomId, key } = await deriveSignalingSecrets(code);
    const url = new URL(relayUrl ?? defaultRelayUrl());
    url.searchParams.set("room", roomId);

    const socket = new WebSocket(url.toString());
    await new Promise<void>((resolve, reject) => {
      // A relay that is down or unreachable often produces neither "open" nor
      // "error" for a long time, and the page sat on "joining" indefinitely.
      const timer = setTimeout(() => {
        socket.close();
        reject(
          new Error(
            `the signaling relay at ${url.origin} did not answer within ${RELAY_CONNECT_TIMEOUT_MS / 1000} seconds`,
          ),
        );
      }, RELAY_CONNECT_TIMEOUT_MS);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          reject(
            new Error(`cannot reach the signaling relay at ${url.origin}`),
          );
        },
        { once: true },
      );
    });

    return new SignalingChannel(socket, key, normalizePairingCode(code));
  }

  onPaired(listener: () => void): void {
    this.pairedListener = listener;
  }

  onMessage(listener: (message: SignalingMessage) => void): void {
    this.messageListener = listener;
  }

  onError(listener: (error: string) => void): void {
    this.errorListener = listener;
  }

  async send(message: SignalingMessage): Promise<void> {
    this.socket.send(await sealMessage(this.key, message));
  }

  close(): void {
    this.socket.close();
  }

  private async receive(text: string): Promise<void> {
    // Relay notices are plain JSON; peer traffic is sealed.
    if (text.startsWith("{")) {
      const notice = JSON.parse(text) as { relay?: string };
      if (notice.relay === "paired") this.pairedListener?.();
      if (notice.relay === "full") this.errorListener?.("that code is in use");
      if (notice.relay === "left") this.errorListener?.("the other side left");
      return;
    }

    try {
      const message = await openMessage(this.key, text);
      this.messageListener?.(message);
    } catch {
      // Someone in the room without the code, or a tampered payload.
      this.errorListener?.(
        "ignored a signaling message that failed to decrypt",
      );
    }
  }
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function toBase64(buffer: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64(text: string): ArrayBuffer {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}
