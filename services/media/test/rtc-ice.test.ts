import { describe, expect, it } from "vitest";
import { candidateTypeOf, candidateTypes } from "../src/rtc.js";
import { WebRtcIngestSession } from "../src/rtc.js";

/**
 * ICE diagnostics coverage (ADAAAA-7582). The answer's candidate types are the
 * only way to tell "the answerer never gathered a reachable candidate" apart
 * from "the browser never sent RTP", so they must be parsed correctly.
 */
describe("candidate diagnostics", () => {
  it("counts answer candidates by type", () => {
    const sdp = [
      "v=0",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=candidate:1 1 udp 2116026367 172.18.0.5 33902 typ host generation 0",
      "a=candidate:2 1 udp 1679818751 136.33.135.223 33902 typ srflx raddr 172.18.0.5 rport 33902",
      "a=candidate:3 1 udp 16777215 136.33.135.223 49153 typ relay raddr 192.168.1.1 rport 51476",
      "a=end-of-candidates",
    ].join("\r\n");
    expect(candidateTypes(sdp)).toEqual({ host: 1, srflx: 1, relay: 1 });
  });

  it("returns no types for an answer without candidates", () => {
    expect(candidateTypes("v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n")).toEqual({});
    expect(candidateTypes(undefined)).toEqual({});
  });

  it("classifies a single candidate line", () => {
    expect(candidateTypeOf("candidate:3 1 udp 16777215 136.33.135.223 49153 typ relay raddr x rport y")).toBe("relay");
    expect(candidateTypeOf("candidate:1 1 udp 2116026367 172.18.0.5 33902 typ host")).toBe("host");
    expect(candidateTypeOf(undefined)).toBe("end");
  });
});

describe("WebRtcIngestSession.stats()", () => {
  it("exposes RTC counters and ICE diagnostics", () => {
    const session = new WebRtcIngestSession();
    const stats = session.stats();
    expect(stats).toMatchObject({
      packetsReceived: 0,
      framesEmitted: 0,
      audioPacketsReceived: 0,
      iceState: "new",
      remoteCandidates: 0,
      gatherMs: 0,
    });
    expect(stats.answerCandidates).toEqual({});
  });

  it("counts trickled remote candidates (accepts a bare candidate string)", async () => {
    const session = new WebRtcIngestSession();
    // No peer yet: a candidate before an offer is ignored, not thrown.
    await session.addIceCandidate({ candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ relay", sdpMid: "0", sdpMLineIndex: 0 });
    expect(session.stats().remoteCandidates).toBe(0);
  });
});
