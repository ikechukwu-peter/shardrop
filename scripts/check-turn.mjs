/**
 * Does TURN actually work, and if not, which layer is failing?
 *
 * Fetches credentials from a relay, then gathers ICE with
 * iceTransportPolicy: "relay", which discards host and reflexive candidates:
 * anything gathered was issued by the TURN server itself.
 *
 * Every TURN URL is tried three ways — as given, by IP over UDP, by IP over
 * TCP — because the failures look identical from outside:
 *   hostname fails, IP works  → the browser cannot resolve the TURN host
 *   UDP fails, TCP works      → UDP is blocked on this network
 *   everything fails          → credentials refused, or the server is down
 *
 *   node scripts/check-turn.mjs [relay-url]
 */
import { lookup } from "node:dns/promises";
import { chromium } from "@playwright/test";

const relay = process.argv[2] ?? "http://localhost:8787/turn";

/** "fetch failed" alone says nothing: the reason is in error.cause. */
async function fetchWithRetry(url, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      const cause = error.cause
        ? ` (${error.cause.code ?? error.cause.name}: ${error.cause.message})`
        : "";
      if (attempt >= attempts) {
        console.error(`cannot reach ${url}: ${error.message}${cause}`);
        process.exit(1);
      }
      console.warn(`attempt ${attempt} failed${cause}; retrying`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

const { iceServers } = await (await fetchWithRetry(relay)).json();
const turn = (iceServers ?? []).filter((server) =>
  [server.urls].flat().some((url) => url.startsWith("turn")),
);
if (turn.length === 0) {
  console.error(`${relay} returned no TURN servers: none is configured.`);
  process.exit(1);
}

/** Every variant worth trying for one TURN URL. */
async function variantsOf(url) {
  const match = /^(turns?):([^:?]+):(\d+)/.exec(url);
  if (!match) return [{ label: url, url }];
  const [, scheme, host, port] = match;
  const variants = [{ label: `${scheme} ${host}:${port}`, url }];

  // TLS needs the hostname for its certificate, so turns: is tried as given.
  if (scheme === "turn") {
    const address = await lookup(host, { family: 4 })
      .then((result) => result.address)
      .catch(() => null);
    if (address) {
      variants.push(
        {
          label: `turn ${address}:${port} udp`,
          url: `turn:${address}:${port}`,
        },
        {
          label: `turn ${address}:${port} tcp`,
          url: `turn:${address}:${port}?transport=tcp`,
        },
      );
    }
  }
  return variants;
}

const tests = [];
for (const server of turn) {
  for (const url of [server.urls].flat()) {
    for (const variant of await variantsOf(url)) {
      tests.push({
        ...variant,
        username: server.username,
        credential: server.credential,
      });
    }
  }
}

// Real Chrome when installed: it is what people actually use, and the
// bundled headless shell differs in how it resolves ICE server hostnames.
const browser = await chromium
  .launch({ channel: "chrome" })
  .catch(() => chromium.launch());
const page = await browser.newPage();

console.log(`credentials from ${relay}\n`);
const results = [];
for (const test of tests) {
  const result = await page.evaluate(async ({ url, username, credential }) => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: url, username, credential }],
      iceTransportPolicy: "relay",
    });
    pc.createDataChannel("probe");
    let candidates = 0;
    const errors = [];
    pc.addEventListener("icecandidate", (event) => {
      if (event.candidate?.candidate) candidates++;
    });
    pc.addEventListener("icecandidateerror", (event) => {
      errors.push(`${event.errorCode} ${event.errorText}`);
    });
    await pc.setLocalDescription(await pc.createOffer());
    await new Promise((resolve) => setTimeout(resolve, 7000));
    pc.close();
    return { candidates, error: errors[0] ?? "" };
  }, test);

  results.push({ ...test, ...result });
  const verdict = result.candidates > 0 ? "WORKS" : "fails";
  const detail =
    result.error || (result.candidates ? "" : "no response (timeout)");
  console.log(`  ${verdict.padEnd(6)} ${test.label.padEnd(40)} ${detail}`);
}
await browser.close();

const working = results.filter((result) => result.candidates > 0);
const byHostname = working.some(
  (result) => !/\d+\.\d+\.\d+\.\d+/.test(result.label),
);
const dnsFailures = results.some((result) => result.error.startsWith("701"));

console.log("");
if (working.length === 0) {
  console.log(
    "TURN is NOT usable from this network. With every variant failing, the\n" +
      "credentials are being refused or the server is not answering. Use a TURN\n" +
      "account of your own (metered.ca has a free tier) instead of a shared one.",
  );
  process.exit(1);
}
if (!byHostname && dnsFailures) {
  console.log(
    "TURN works by IP but the browser cannot resolve its hostname. Serve the\n" +
      "TURN URL as an IP address from the relay (TURN_URL=turn:<ip>:<port>).",
  );
  process.exit(0);
}
console.log(`TURN works from this network (${working[0].label}).`);
