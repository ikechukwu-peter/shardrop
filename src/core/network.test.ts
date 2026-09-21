import { describe, expect, it } from "vitest";
import { connectionKindFromStats } from "./peer";
import { quotaVerdict } from "./chunk-store";

const pair = (localType: string, remoteType: string) => [
  {
    type: "candidate-pair",
    nominated: true,
    state: "succeeded",
    localCandidateId: "L",
    remoteCandidateId: "R",
  },
  { type: "local-candidate", id: "L", candidateType: localType },
  { type: "remote-candidate", id: "R", candidateType: remoteType },
];

describe("connectionKindFromStats", () => {
  it("calls a host-to-host pair direct", () => {
    expect(connectionKindFromStats(pair("host", "host"))).toBe("direct");
  });

  it("calls a NAT-traversed pair direct: srflx is still peer to peer", () => {
    expect(connectionKindFromStats(pair("srflx", "srflx"))).toBe("direct");
  });

  it("calls it relayed when either end is a TURN relay", () => {
    expect(connectionKindFromStats(pair("relay", "srflx"))).toBe("relayed");
    expect(connectionKindFromStats(pair("host", "relay"))).toBe("relayed");
  });

  it("is unknown before a pair is nominated", () => {
    expect(connectionKindFromStats([])).toBe("unknown");
    expect(
      connectionKindFromStats([
        { type: "candidate-pair", state: "in-progress", nominated: false },
      ]),
    ).toBe("unknown");
  });
});

describe("quotaVerdict", () => {
  const GB = 1024 ** 3;

  it("accepts a file that fits with room to spare", () => {
    expect(quotaVerdict(1 * GB, 10 * GB, 2 * GB).ok).toBe(true);
  });

  it("refuses a file larger than what is left", () => {
    const verdict = quotaVerdict(9 * GB, 10 * GB, 2 * GB);
    expect(verdict.ok).toBe(false);
    expect(verdict.available).toBe(8 * GB);
    expect(verdict.reason).toContain("storage");
  });

  it("refuses a file that only just fits: assembling it needs room too", () => {
    expect(quotaVerdict(100, 105, 0).ok).toBe(false);
  });

  it("allows the transfer when the browser reports no quota", () => {
    expect(quotaVerdict(5 * GB, undefined, undefined).ok).toBe(true);
  });

  it("treats a full quota as no space at all", () => {
    expect(quotaVerdict(1, 10, 10).available).toBe(0);
  });
});
