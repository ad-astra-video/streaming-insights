/**
 * Token-savings insight contract (Phase 0b decision, ADAAAA-7547).
 *
 * A `WindowEvent` is the per-window insight row the token-savings dashboard
 * consumes. It pairs the measured codec-native counts (from the runner's
 * per-window NDJSON telemetry line) with the analytic dense baseline and
 * running session-level savings.
 */

export type GateDecision = "silent" | "speak";

/** Running per-session counters, updated as windows are folded in. */
export interface SessionCounters {
  /** Total windows observed. */
  windows: number;
  silentWindows: number;
  speakWindows: number;
  /** Sum of codec-native visual tokens (`tokensVisual`). */
  tokensVisualTotal: number;
  /** Sum of the analytic dense baseline (`tokensBaselineDense`). */
  tokensBaselineDenseTotal: number;
  /** Sum of VLM-generated tokens (`tokensGenerated`; 0 on silent windows). */
  tokensGeneratedTotal: number;
  /** Sum of `windowSavings` over all windows observed. */
  tokensSavedTotal: number;
}

/** One per-window token-savings insight event. */
export interface WindowEvent {
  /** Session the window belongs to. */
  sessionId: string;
  /** Monotonic window index within the session (the runner's `window`). */
  seq: number;
  /** Window start, seconds from stream start. */
  tStart: number;
  /** Window end, seconds from stream start. */
  tEnd: number;
  /** P(speak) = `softmax(gate_logits at segment boundary)[:, 1]`. */
  pSpeak: number;
  /** Gate decision: `pSpeak >= gateThreshold` (0.5) => `speak`. */
  decision: GateDecision;
  /**
   * Codec-native visual token count:
   * `int(segment["image_grid_thw"][:, 0].sum())`.
   */
  tokensVisual: number;
  /**
   * Analytic dense baseline:
   * `framesInWindow * ceil(h / 16) * ceil(w / 16)` (no dense model run).
   */
  tokensBaselineDense: number;
  /** VLM-generated tokens for the window (0 for a silent gate window). */
  tokensGenerated: number;
  /** `max(tokensBaselineDense - tokensVisual, 0)` — codec-token savings. */
  windowSavings: number;
  /**
   * `sum(windowSavings)` over every window observed so far, including this
   * one.
   */
  cumulativeSavings: number;
  /** Session-wide counters after folding this window in. */
  sessionCounters: SessionCounters;
}

export const EMPTY_SESSION_COUNTERS: SessionCounters = {
  windows: 0,
  silentWindows: 0,
  speakWindows: 0,
  tokensVisualTotal: 0,
  tokensBaselineDenseTotal: 0,
  tokensGeneratedTotal: 0,
  tokensSavedTotal: 0,
};
