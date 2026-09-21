import { describe, expect, it } from "vitest";
import { extractFingerprints, safetyWords } from "./verify";

const sdpWith = (fingerprint: string) =>
  [
    "v=0",
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    `a=fingerprint:sha-256 ${fingerprint}`,
    "a=setup:actpass",
  ].join("\r\n");

const A = "A4:3C:8A:B3:6C:A5:02:CF:A7:B6:41:03:3A:9F:64:63";
const B = "11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00";
const ATTACKER = "DE:AD:BE:EF:00:11:22:33:44:55:66:77:88:99:AA:BB";

describe("extractFingerprints", () => {
  it("finds the fingerprint in an SDP", () => {
    expect(extractFingerprints(sdpWith(A))).toEqual([A.toLowerCase()]);
  });

  it("finds one per media section", () => {
    expect(extractFingerprints(`${sdpWith(A)}\r\n${sdpWith(B)}`)).toHaveLength(
      2,
    );
  });

  it("returns nothing when there is no fingerprint", () => {
    expect(extractFingerprints("v=0\r\na=setup:actpass")).toEqual([]);
  });
});

describe("safetyWords", () => {
  it("gives four words", async () => {
    expect(await safetyWords(sdpWith(A), sdpWith(B))).toHaveLength(4);
  });

  it("gives both peers the same words, whichever side they are on", async () => {
    const onA = await safetyWords(sdpWith(A), sdpWith(B));
    const onB = await safetyWords(sdpWith(B), sdpWith(A));
    expect(onA).toEqual(onB);
  });

  it("is stable for the same pair of certificates", async () => {
    expect(await safetyWords(sdpWith(A), sdpWith(B))).toEqual(
      await safetyWords(sdpWith(A), sdpWith(B)),
    );
  });

  it("differs when a machine in the middle substitutes a certificate", async () => {
    // The attacker shows its own certificate to each side, so the two sides
    // derive different words: that mismatch is the whole point.
    const victimSees = await safetyWords(sdpWith(A), sdpWith(ATTACKER));
    const otherSees = await safetyWords(sdpWith(B), sdpWith(ATTACKER));
    const honest = await safetyWords(sdpWith(A), sdpWith(B));
    expect(victimSees).not.toEqual(honest);
    expect(otherSees).not.toEqual(honest);
    expect(victimSees).not.toEqual(otherSees);
  });

  it("uses words from the spoken-safe list only", async () => {
    const words = await safetyWords(sdpWith(A), sdpWith(B));
    for (const word of words) expect(word).toMatch(/^[a-z]{4,8}$/);
  });

  it("refuses when a side offers no fingerprint", async () => {
    await expect(safetyWords(sdpWith(A), "v=0")).rejects.toThrow("fingerprint");
  });
});
