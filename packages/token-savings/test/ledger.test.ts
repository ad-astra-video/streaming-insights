import { describe, expect, it } from "vitest";
import {
  denseBaselineTokens,
  frameCountInWindow,
} from "../src/baseline.js";
import {
  SessionLedger,
  parseRunnerTelemetryLine,
} from "../src/index.js";
import { codecTokensSaved, savingsPct } from "../src/codec.js";

const LINE_SILENT =
  '{"window":0,"tStart":0.0,"tEnd":8.0,"pSpeak":0.191,"decision":"silent","tokensVisual":40,"tokensGenerated":0,"responseText":null}';
const LINE_SPEAK =
  '{"window":1,"tStart":8.0,"tEnd":16.0,"pSpeak":0.551,"decision":"speak","tokensVisual":312,"tokensGenerated":64,"responseText":"The video features ..."}';

describe("dense baseline", () => {
  it("computes framesInWindow from duration and effective fps", () => {
    expect(frameCountInWindow(0, 8, 2)).toBe(16);
    // codec-native effective fps: 8s window at 24 fps native = 192 frames
    expect(frameCountInWindow(0, 8, 24)).toBe(192);
    expect(frameCountInWindow(8, 16, 24)).toBe(192);
  });

  it("computes the analytic dense baseline framesInWindow x ceil(h/16) x ceil(w/16)", () => {
    // 960x540 sample clip: ceil(540/16)=34, ceil(960/16)=60 -> 2040 patches/frame
    const patchesPerFrame = Math.ceil(540 / 16) * Math.ceil(960 / 16);
    expect(patchesPerFrame).toBe(2040);
    // 16 frames at 960x540
    expect(denseBaselineTokens(16, 540, 960)).toBe(16 * 2040);
    // fractional frame counts round up the frame product but not the grid
    expect(denseBaselineTokens(1.5, 32, 32)).toBe(1.5 * 4);
    expect(denseBaselineTokens(0, 540, 960)).toBe(0);
  });

  it("rejects non-positive fps and inverted windows", () => {
    expect(() => frameCountInWindow(0, 8, 0)).toThrow(RangeError);
    expect(() => frameCountInWindow(8, 0, 24)).toThrow(RangeError);
  });
});

describe("savings", () => {
  it("floors windowSavings at zero and computes savingsPct", () => {
    expect(codecTokensSaved(400, 40)).toBe(360);
    expect(codecTokensSaved(30, 40)).toBe(0);
    expect(savingsPct(400, 40)).toBeCloseTo(0.9);
    expect(savingsPct(0, 0)).toBe(0);
  });
});

describe("runner telemetry parsing", () => {
  it("parses valid lines and rejects malformed/blank lines", () => {
    expect(parseRunnerTelemetryLine(LINE_SILENT)?.window).toBe(0);
    expect(parseRunnerTelemetryLine(LINE_SPEAK)?.tokensGenerated).toBe(64);
    expect(parseRunnerTelemetryLine("")).toBeNull();
    expect(parseRunnerTelemetryLine("not json")).toBeNull();
    expect(parseRunnerTelemetryLine('{"window":-1}')).toBeNull();
    expect(
      parseRunnerTelemetryLine('{"window":0,"pSpeak":1.5}'),
    ).toBeNull();
  });
});

describe("SessionLedger (token_ledger consumer)", () => {
  const ctx = { sessionId: "s1", height: 540, width: 960, effectiveFps: 24 };

  it("consumes NDJSON lines, computes baseline, savings and counters", () => {
    const ledger = new SessionLedger(ctx);
    const accepted = ledger.consume([LINE_SILENT, LINE_SPEAK, "junk line"]);
    expect(accepted).toBe(2);

    const events = ledger.snapshot();
    expect(events).toHaveLength(2);

    // 8s window @ 24 fps = 192 frames; 960x540 -> 2040 patches/frame
    const baseline = 192 * 2040;
    expect(events[0].tokensBaselineDense).toBe(baseline);
    const savings0 = baseline - 40;
    const savings1 = baseline - 312;
    expect(events[0].windowSavings).toBe(savings0);
    expect(events[0].cumulativeSavings).toBe(savings0);
    expect(events[1].cumulativeSavings).toBe(savings0 + savings1);

    const counters = events[1].sessionCounters;
    expect(counters.windows).toBe(2);
    expect(counters.silentWindows).toBe(1);
    expect(counters.speakWindows).toBe(1);
    expect(counters.tokensVisualTotal).toBe(352);
    expect(counters.tokensBaselineDenseTotal).toBe(baseline * 2);
    expect(counters.tokensGeneratedTotal).toBe(64);
    expect(counters.tokensSavedTotal).toBe((baseline - 40) + (baseline - 312));

    const summary = ledger.summary();
    expect(summary.sessionId).toBe("s1");
    expect(summary.streamSeconds).toBe(16);
    expect(summary.savingsPct).toBeGreaterThan(0.9);
  });

  it("returns zeroed counters for an empty session", () => {
    const summary = new SessionLedger(ctx).summary();
    expect(summary.counters.windows).toBe(0);
    expect(summary.savingsPct).toBe(0);
    expect(summary.streamSeconds).toBe(0);
  });
});
