import type { StreamWindowEvent } from "@streaming-insights/shared";
import { accumulateMetrics, type TokenMetrics } from "./metrics";

/**
 * Token-savings dashboard derivation (Phase 5, ADAAAA-7552).
 *
 * The live metric card in `metrics.ts` tracks cumulative totals; this module
 * adds the per-window and time-series views the dashboard needs:
 *
 *  - the "tokens saved this window" live counter (the most recent window),
 *  - a p_speak sparkline series with silent-vs-speak bands,
 *  - a why-silent explainer per window,
 *  - stream-minutes vs tokens-avoided as two separate counters.
 *
 * Pure and UI-agnostic so it can be unit-tested in isolation.
 */

/** One point in the p_speak sparkline series. */
export interface SparkPoint {
  seq: number;
  /** Gate confidence in [0,1] that this window warranted a response. */
  pSpeak: number;
  decision: "silent" | "speak";
  tStart: number;
  tEnd: number;
}

/** Structured per-window "why silent / why speak" explainer. */
export interface WindowExplainer {
  decision: "silent" | "speak";
  /** Short human-readable headline, e.g. "routine content — gate silent". */
  headline: string;
  /** Supporting detail, e.g. the p_speak value against the gate threshold. */
  detail: string;
}

/** Aggregated dashboard state for a session. */
export interface Dashboard {
  metrics: TokenMetrics;
  /** Sum of window durations, in seconds. */
  streamSeconds: number;
  /** `streamSeconds / 60`. */
  streamMinutes: number;
  /** Cumulative tokens avoided vs the dense baseline (== metrics.tokensSavedTotal). */
  tokensAvoided: number;
  /** The per-window p_speak sparkline, in stream order. */
  spark: SparkPoint[];
  /** The most recent window, or null when no windows have been observed. */
  latest: StreamWindowEvent | null;
}

/** Gate threshold from the pinned runtime config (`pSpeak >= 0.5 => speak`). */
export const GATE_THRESHOLD = 0.5;

/** Human-readable why-silent / why-speak explainer for one window. */
export function explainWindow(e: StreamWindowEvent): WindowExplainer {
  const p = e.gate.pSpeak;
  if (e.gate.decision === "silent") {
    return {
      decision: "silent",
      headline: "routine content — gate silent",
      detail: `pSpeak ${p.toFixed(2)} — below the ${GATE_THRESHOLD.toFixed(
        2,
      )} gate threshold`,
    };
  }
  return {
    decision: "speak",
    headline: "noteworthy content — gate fired",
    detail: `pSpeak ${p.toFixed(2)} — at/above the ${GATE_THRESHOLD.toFixed(
      2,
    )} gate threshold`,
  };
}

/** Turn a window event into its sparkline point. */
export function toSparkPoint(e: StreamWindowEvent): SparkPoint {
  return {
    seq: e.seq,
    pSpeak: e.gate.pSpeak,
    decision: e.gate.decision,
    tStart: e.tStart,
    tEnd: e.tEnd,
  };
}

/** Derive the full dashboard state from the window event list. */
export function deriveDashboard(events: StreamWindowEvent[]): Dashboard {
  const metrics = accumulateMetrics(events);
  const streamSeconds = events.reduce((acc, e) => acc + (e.tEnd - e.tStart), 0);
  const spark = events.map(toSparkPoint);
  const latest = events.length > 0 ? events[events.length - 1] : null;

  return {
    metrics,
    streamSeconds,
    streamMinutes: streamSeconds / 60,
    tokensAvoided: metrics.tokensSavedTotal,
    spark,
    latest,
  };
}
