/**
 * Does TURN actually work?
 *
 * Fetches credentials from a relay, then gathers ICE with
 * iceTransportPolicy: "relay", which discards host and reflexive candidates.
 * Anything gathered proves the TURN server accepted the credentials and is
 * reachable from this network; nothing gathered prints why.
 *
 *   node scripts/check-turn.mjs [relay-url]
 */
import { chromium } from "@playwright/test";

const relay = process.argv[2] ?? "http://localhost:8787/turn";

const response = await fetch(relay).catch((error) => {
  console.error(`cannot reach ${relay}: ${error.message}`);
  process.exit(1);
});
const { iceServers } = await response.json();

if (!iceServers?.length) {
  console.error(
    `${relay} returned no ICE servers: no TURN provider is configured on the relay.`,
  );
  process.exit(1);
}
console.log(`credentials from ${relay}:`);
for (const server of iceServers) {
  console.log(`  ${[server.urls].flat().join(", ")}`);
}

const browser = await chromium.launch();
const page = await browser.newPage();
const { candidates, errors } = await page.evaluate(async (servers) => {
  const pc = new RTCPeerConnection({
    iceServers: servers,
    iceTransportPolicy: "relay",
  });
  pc.createDataChannel("probe");
  const candidates = [];
  const errors = [];
  pc.addEventListener("icecandidate", (event) => {
    if (event.candidate?.candidate) candidates.push(event.candidate.candidate);
  });
  pc.addEventListener("icecandidateerror", (event) => {
    errors.push(`${event.url ?? "?"}: ${event.errorCode} ${event.errorText}`);
  });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => setTimeout(resolve, 8000));
  pc.close();
  return { candidates, errors };
}, iceServers);
await browser.close();

console.log(`\nrelay candidates: ${candidates.length}`);
for (const candidate of candidates) console.log(`  ${candidate}`);

if (errors.length) {
  console.log(`\nerrors:`);
  for (const error of errors) console.log(`  ${error}`);
  console.log(
    `\n701 means the hostname did not resolve from here; 401 or 403 means the` +
      ` credentials were refused; a timeout usually means the port is blocked.`,
  );
}

if (candidates.length === 0) {
  console.error("\nTURN is NOT usable from this network.");
  process.exit(1);
}
console.log("\nTURN works from this network.");
