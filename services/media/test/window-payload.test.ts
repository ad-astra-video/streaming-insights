import { describe, expect, it } from "vitest";
import { buildWindowPayloads } from "../src/window-payload.js";
import type { WindowOutcome } from "../src/runner-client.js";

const speak = (over: Partial<WindowOutcome> = {}): WindowOutcome => ({
  pSpeak: 0.82,
  decision: "speak",
  tokensVisual: 276,
  tokensBaselineDense: 1152,
  tokensGenerated: 12,
  responseText: "A red car cuts across.",
  ...over,
});

describe("buildWindowPayloads (media -> control persistence contract)", () => {
  it("keeps the ledger row and the event in agreement", () => {
    const { ledger, event } = buildWindowPayloads(speak(), { seq: 4, tStart: 8, tEnd: 10 }, "watch");
    expect(ledger.seq).toBe(4);
    expect(ledger.tokensVisual).toBe(event.tokens.visual);
    expect(ledger.tokensGenerated).toBe(event.tokens.generated);
    expect(ledger.tokensBaselineDense).toBe(event.tokens.baselineDense);
    expect(event.prompt).toBe("watch");
    expect(event.event).toEqual({ type: "response", text: "A red car cuts across." });
  });

  it("rounds fractional runner token counts to whole tokens (integer ledger columns)", () => {
    // A multimodal usage block is not guaranteed integral; the control write
    // used to 500 on a fractional count and drop the window entirely.
    const { ledger, event } = buildWindowPayloads(
      speak({ tokensVisual: 262.5, tokensBaselineDense: 1152.4, tokensGenerated: 22.6 }),
      { seq: 0, tStart: 0, tEnd: 2 },
      undefined
    );
    expect(ledger.tokensVisual).toBe(263);
    expect(ledger.tokensBaselineDense).toBe(1152);
    expect(ledger.tokensGenerated).toBe(23);
    expect(Number.isInteger(ledger.tokensVisual)).toBe(true);
    expect(Number.isInteger(ledger.tokensBaselineDense)).toBe(true);
    expect(Number.isInteger(ledger.tokensGenerated)).toBe(true);
    expect(event.tokens.visual).toBe(263);
  });

  it("never emits a negative or non-finite token count", () => {
    const { ledger } = buildWindowPayloads(
      speak({ tokensVisual: -5, tokensBaselineDense: 0, tokensGenerated: Number.NaN }),
      { seq: 0, tStart: 0, tEnd: 1 },
      undefined
    );
    expect(ledger.tokensVisual).toBe(0);
    expect(ledger.tokensBaselineDense).toBe(0);
    expect(ledger.tokensGenerated).toBe(0);
  });

  it("reports 0 generated tokens on a silent window and a fraction savedVsBaseline", () => {
    const { ledger, event } = buildWindowPayloads(
      speak({ decision: "silent", pSpeak: 0, tokensVisual: 180, tokensGenerated: 40, responseText: null }),
      { seq: 1, tStart: 2, tEnd: 4 },
      undefined
    );
    expect(ledger.tokensGenerated).toBe(0);
    expect(event.tokens.generated).toBe(0);
    expect(event.event).toEqual({ type: "silent", text: null });
    expect(event.tokens.savedVsBaseline).toBeCloseTo(1 - 180 / 1152, 6);
    expect(event.tokens.savedVsBaseline).toBeLessThanOrEqual(1);
  });
});
