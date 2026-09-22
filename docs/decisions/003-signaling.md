# 003 — One pairing code that is also the encryption key

## Context

Manual signaling (copy the offer, paste it, copy the answer back) needs no relay to carry the pairing messages, but it is slow, needs two round trips by hand, and in practice only works between two tabs or two devices on one network. Pairing had to become: one side shows a code, the other opens a link or types it.

A browser cannot reach another browser unaided, so that means a signaling relay. The question is what the relay is trusted with.

## The risk a relay introduces

The SDP contains `a=fingerprint:sha-256 …`, the hash of the DTLS certificate. The connection's encryption authenticates against that fingerprint. A relay that can rewrite SDP can substitute its own fingerprint on each side and sit in the middle of what both users are told is a direct connection. Copy-paste signaling had no such party; adding a relay creates one.

## Options

**A. Trust the relay.** Room id in the URL, plaintext SDP. Simple, and how most demos work. The relay operator can silently intercept every transfer.

**B. Room id from the code, SDP encrypted with a key derived from the same code.** The code lives in the URL fragment, which browsers never send to a server. The relay sees an opaque room id and ciphertext.

**C. Out-of-band verification.** Show both users a short code derived from the two fingerprints and ask them to compare it aloud. Strong, but it needs the users to actually do it.

## Decision

Option B, with option C left as future work.

One 16-character Crockford base32 code (80 bits) is the only secret. HKDF-SHA256 derives two things from it:

```text
code ──HKDF(info="room")────────► room id (128 bits, hex)  → given to the relay
     └─HKDF(info="aes-gcm-key")─► AES-256-GCM key          → never leaves the browser
```

Every signaling payload is sealed with AES-GCM, which also authenticates it, so the relay can neither read the SDP nor forge one. A tampered envelope fails to decrypt and is ignored.

The code travels in the URL fragment (`#c=…`), which is not sent in the HTTP request, so a relay that also serves the page still never sees it.

## Consequences

- **The relay is untrusted infrastructure.** It only introduces two sockets that hold the same room id. It cannot join the conversation without the code.
- **Whoever has the code can pair.** 80 bits is far beyond guessing, but a code shared in a group chat is a shared key. Codes are single-use and rooms disappear when a socket closes.
- **No forward secrecy and no verification of _who_ holds the code.** Option C (comparing a fingerprint-derived short code) would fix the second, and is the obvious next step.
- **Relay compromise is not transfer compromise**, but a hostile relay can still deny service by dropping envelopes.
- **Cross-network still depends on ICE.** STUN is configured; peers behind symmetric NAT or blocked UDP need TURN, which is not set up. The UI must say "direct" or "relayed" once TURN exists (idea.md rule 4).
- The relay is ~70 lines with one dependency (`ws`), so it can be deployed anywhere or replaced with a Cloudflare Worker.
