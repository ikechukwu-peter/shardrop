# 006 — TURN credentials from the relay, and a relay you only need for a moment

## Context

Laptop to phone on the same Wi-Fi connected directly from the first deployment. The same phone on mobile data never connected. Mobile carriers put phones behind carrier-grade NAT (CGNAT): the phone has no address another device can reach, and no amount of STUN discovers one. The only way through is a TURN server, which relays the encrypted packets between the two peers.

TURN needs credentials, and credentials in the page are credentials for every visitor.

## Options for credentials

**A. Static credentials baked into the build** (`VITE_TURN_*`). Simplest. Anyone who opens the page can read them and use the TURN allowance for anything, indefinitely.

**B. The provider's browser snippet.** metered.ca's example fetches credentials in the page with the API key in the URL — which publishes the API key instead of the credentials.

**C. The signaling relay mints them.** The long-lived key stays on the server; the page asks `GET /turn` and receives credentials that expire. The relay already exists, already holds secrets, and is already the thing the page talks to first.

## Decision

Option C. The relay supports four providers, tried in order, so switching is a secret change rather than a code change:

| Provider            | Configured by                                | Credentials the browser gets                |
| ------------------- | -------------------------------------------- | ------------------------------------------- |
| metered.ca          | `METERED_DOMAIN`, `METERED_API_KEY`          | Minted by metered for the project's API key |
| Cloudflare Realtime | `TURN_KEY_ID`, `TURN_KEY_API_TOKEN`          | Minted, with a two-hour TTL                 |
| coturn              | `TURN_URL`, `TURN_SECRET`                    | HMAC of an expiry (the TURN REST API)       |
| Static              | `TURN_URL`, `TURN_USERNAME`, `TURN_PASSWORD` | Fixed, still served from the relay          |

`/turn` is CORS-restricted to `ALLOWED_ORIGINS` and marked `no-store`. The relay reuses a set of credentials for up to two hours, a few minutes short of their lifetime, rather than asking the provider on every pairing. The relay logs its provider at startup.

The TURN server cannot read what it relays: DTLS runs end to end between the two browsers, and the four safety words would differ if anything terminated it in the middle.

## The relay's lifecycle

The relay's job is to carry one sealed offer and one sealed answer. Once the peer connection opens, the page closes its socket. Holding it open had two costs: the relay stayed awake for nothing, and when a relay restarted mid-transfer it told the other device "the other side left" about a transfer that was going fine.

Because the relay suspends when idle, the page requests `/healthz` as soon as it loads, so the relay is usually awake before a code is created and scanned.

## Deadlines

Every wait on the network now has one, because each missing one surfaced as an interface that sat on a status forever:

| Wait                        | Deadline                        | Symptom without it                             |
| --------------------------- | ------------------------------- | ---------------------------------------------- |
| ICE gathering               | 4 s, then use what was gathered | An unreachable STUN server hung offer creation |
| Joining the relay           | 10 s                            | A stopped relay left the phone on "joining"    |
| The peer connection opening | 20 s                            | Carrier NAT left the page on "connecting"      |
| An unacknowledged shard     | 5 s, then resend                | A shard lost in flight hung the transfer       |

## Consequences

- **Relayed transfers spend a quota.** The site is public, so anyone who needs a relay spends the TURN allowance. The metered project has a quota set to _disable_ when exceeded: relayed connections stop, direct ones carry on, and the page explains why.
- **Credentials are fetched once per page load.** A page left open past the credentials' lifetime will offer expired ones. Reloading fixes it; refreshing them automatically is not done.
- **The relay host must stay up long enough to pair.** A trial Fly account stops machines after five minutes. After pairing that no longer matters, but a stopped relay cannot pair anyone, so it needs a paid (in practice near-free) account.
- **A free public TURN server is not a plan.** The widely suggested Open Relay static-auth endpoint answered on none of its ports when tested, while metered's and Cloudflare's answered at once. `npm run turn:check` tells the two cases apart.
