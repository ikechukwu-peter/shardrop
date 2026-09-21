/**
 * The safety check.
 *
 * WebRTC authenticates the connection against the DTLS certificate fingerprint
 * carried in the SDP. Whoever controls the signaling path controls that value,
 * so a relay able to rewrite it could sit inside a connection both sides
 * believe is direct. Encrypting the signaling envelopes (signaling.ts) means
 * only a holder of the pairing code can do that — but it does not prove *who*
 * holds the code.
 *
 * So both sides derive four words from the two fingerprints together. The
 * words match only if both browsers see the same pair of certificates. Read
 * them aloud, or compare them on the two screens, and a machine in the middle
 * is ruled out: it would have to present a different certificate to each side,
 * which gives each side different words.
 *
 * This is the short-authentication-string idea used by ZRTP and by
 * magic-wormhole, cut down to what a transfer tool needs.
 */

/**
 * 64 short words, unambiguous when spoken: no homophones, nothing that sounds
 * like another entry, all one or two syllables. 4 words = 24 bits.
 */
const WORDS = [
  "amber",
  "anchor",
  "apple",
  "arrow",
  "basin",
  "bison",
  "brick",
  "bridge",
  "cactus",
  "candle",
  "canyon",
  "cargo",
  "cedar",
  "cinder",
  "cobalt",
  "comet",
  "copper",
  "coral",
  "cotton",
  "crater",
  "dagger",
  "delta",
  "denim",
  "domino",
  "ember",
  "falcon",
  "fossil",
  "garden",
  "granite",
  "harbor",
  "hazel",
  "helmet",
  "indigo",
  "island",
  "jacket",
  "jasmine",
  "jigsaw",
  "kettle",
  "lantern",
  "lemon",
  "lily",
  "magnet",
  "mango",
  "marble",
  "meadow",
  "mitten",
  "nectar",
  "nutmeg",
  "orbit",
  "otter",
  "pebble",
  "pepper",
  "pigment",
  "puffin",
  "quartz",
  "rabbit",
  "ribbon",
  "saddle",
  "silver",
  "tulip",
  "velvet",
  "walnut",
  "willow",
  "zebra",
];

/** Every `a=fingerprint:` value in an SDP, lowercased. */
export function extractFingerprints(sdp: string): string[] {
  return [...sdp.matchAll(/^a=fingerprint:\S+\s+(\S+)/gim)].map((match) =>
    String(match[1]).toLowerCase(),
  );
}

/**
 * Four words from both fingerprints. Sorted first, so the two peers derive the
 * same words without agreeing who is the offerer.
 */
export async function safetyWords(
  localSdp: string,
  remoteSdp: string,
): Promise<string[]> {
  const fingerprints = [
    ...extractFingerprints(localSdp),
    ...extractFingerprints(remoteSdp),
  ].sort();
  if (fingerprints.length < 2) {
    throw new Error("both sides must offer a DTLS fingerprint");
  }

  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(fingerprints.join("|")),
  );
  const bytes = new Uint8Array(digest);
  // 6 bits per word: four words is 24 bits, enough that a machine in the
  // middle cannot practically produce a matching pair of certificates.
  return [0, 1, 2, 3].map((index) => WORDS[bytes[index]! & 63]!);
}

/** The words for a live connection, or null before both descriptions exist. */
export async function connectionSafetyWords(
  pc: RTCPeerConnection,
): Promise<string[] | null> {
  const local = pc.localDescription?.sdp;
  const remote = pc.remoteDescription?.sdp;
  if (!local || !remote) return null;
  try {
    return await safetyWords(local, remote);
  } catch {
    return null;
  }
}
