import { describe, it, expect } from "vitest";
import { SimFeed } from "../sim/simSource";
import {
  emptyMetrics,
  metricsAdd,
  accumulateMetrics,
  type TokenMetrics,
} from "../lib/metrics";
import type { StreamWindowEvent } from "@streaming-insights/shared";

/** Deterministic RNG that cycles through a fixed list of values. */
function seqRand(values: number[]) {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("SimFeed", () => {
  it("emits a monotonically increasing window sequence", () => {
    const feed = new SimFeed({
      sessionId: "s1",
      windowSec: 8,
      rand: seqRand([0.5, 0.4, 0.2, 0.1]),
    });
    const a = feed.next();
    const b = feed.next();
    const c = feed.next();
    expect(a.seq).toBe(0);
    expect(b.seq).toBe(1);
    expect(c.seq).toBe(2);
    expect(a.tStart).toBe(0);
    expect(a.tEnd).toBe(8);
    expect(b.tStart).toBe(8);
    expect(b.tEnd).toBe(16);
  });

  it("marks a high-pSpeak window as speak with generated tokens + response", () => {
    const feed = new SimFeed({
      sessionId: "s1",
      rand: seqRand([0.9, 0.1, 0.2, 0.5]),
    });
    const e = feed.next("track the ball");
    expect(e.gate.decision).toBe("speak");
    expect(e.gate.pSpeak).toBeCloseTo(0.545, 2);
    expect(e.tokens.generated).toBeGreaterThan(0);
    expect(e.event?.text).toContain("track the ball");
    expect(e.prompt).toBe("track the ball");
  });

  it("marks a low-pSpeak window as silent with ~0 generated tokens", () => {
    const feed = new SimFeed({
      sessionId: "s1",
      rand: seqRand([0.5, 0.5, 0.2]),
    });
    const e = feed.next();
    expect(e.gate.decision).toBe("silent");
    expect(e.gate.pSpeak).toBeCloseTo(0.2, 2);
    expect(e.tokens.generated).toBe(0);
    expect(e.event).toBeUndefined();
    expect(e.tokens.baselineDense).toBeGreaterThan(e.tokens.visual);
  });

  it("always keeps savedVsBaseline in [0,1]", () => {
    const feed = new SimFeed({
      sessionId: "s1",
      rand: seqRand([0.2, 0.3, 0.18, 0.9]),
    });
    for (let i = 0; i < 50; i += 1) {
      const e = feed.next();
      expect(e.tokens.savedVsBaseline).toBeGreaterThanOrEqual(0);
      expect(e.tokens.savedVsBaseline).toBeLessThanOrEqual(1);
    }
  });
});

describe("metrics", () => {
  const mk = (decision: "silent" | "speak", gen: number): StreamWindowEvent => ({
    sessionId: "s1",
    seq: 0,
    tStart: 0,
    tEnd: 8,
    gate: { pSpeak: 0.5, decision },
    tokens: { visual: 100, baselineDense: 400, generated: gen, savedVsBaseline: 0.75 },
  });

  it("accumulates silent and speak windows separately", () => {
    let m: TokenMetrics = emptyMetrics;
    m = metricsAdd(m, mk("silent", 0));
    m = metricsAdd(m, mk("speak", 60));
    m = metricsAdd(m, mk("speak", 40));
    expect(m.windows).toBe(3);
    expect(m.silentWindows).toBe(1);
    expect(m.speakWindows).toBe(2);
    expect(m.tokensGeneratedTotal).toBe(100);
    expect(m.tokensSavedTotal).toBe(3 * 300);
  });

  it("reduces an event list via accumulateMetrics", () => {
    const events = [mk("silent", 0), mk("speak", 20)];
    const m = accumulateMetrics(events);
    expect(m.windows).toBe(2);
    expect(m.tokensGeneratedTotal).toBe(20);
    expect(m.savedVsBaseline).toBeCloseTo(0.75, 2);
  });
});
