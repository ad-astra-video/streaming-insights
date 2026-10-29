import type { StreamWindowEvent } from "@streaming-insights/shared";

/**
 * Aggregated token-savings metrics for a session, derived from the per-window
 * event stream. This mirrors the control server's `/token-summary` aggregation
 * so the webapp's live metric card matches the server contract.
 */
export interface TokenMetrics {
  windows: number;
  silentWindows: number;
  speakWindows: number;
  tokensVisualTotal: number;
  tokensBaselineDenseTotal: number;
  tokensGeneratedTotal: number;
  tokensSavedTotal: number;
  /** 1 - visual / dense, clamped to [0,1]. */
  savedVsBaseline: number;
}

export const emptyMetrics: TokenMetrics = {
  windows: 0,
  silentWindows: 0,
  speakWindows: 0,
  tokensVisualTotal: 0,
  tokensBaselineDenseTotal: 0,
  tokensGeneratedTotal: 0,
  tokensSavedTotal: 0,
  savedVsBaseline: 0,
};

/** Add one window event to a running metrics accumulator (immutable). */
export function metricsAdd(m: TokenMetrics, e: StreamWindowEvent): TokenMetrics {
  const visual = e.tokens.visual;
  const dense = e.tokens.baselineDense;
  const generated = e.gate.decision === "silent" ? 0 : e.tokens.generated;
  const saved = Math.max(dense - visual, 0);

  const windows = m.windows + 1;
  const silentWindows = m.silentWindows + (e.gate.decision === "silent" ? 1 : 0);
  const speakWindows = m.speakWindows + (e.gate.decision === "speak" ? 1 : 0);
  const tokensVisualTotal = m.tokensVisualTotal + visual;
  const tokensBaselineDenseTotal = m.tokensBaselineDenseTotal + dense;
  const tokensGeneratedTotal = m.tokensGeneratedTotal + generated;
  const tokensSavedTotal = m.tokensSavedTotal + saved;
  const savedVsBaseline =
    tokensBaselineDenseTotal > 0
      ? Math.min(tokensSavedTotal / tokensBaselineDenseTotal, 1)
      : 0;

  return {
    windows,
    silentWindows,
    speakWindows,
    tokensVisualTotal,
    tokensBaselineDenseTotal,
    tokensGeneratedTotal,
    tokensSavedTotal,
    savedVsBaseline,
  };
}

/** Reduce a full event list into accumulated metrics. */
export function accumulateMetrics(events: StreamWindowEvent[]): TokenMetrics {
  return events.reduce(metricsAdd, emptyMetrics);
}
