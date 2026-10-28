/**
 * Token-savings engine — the core insight of the streaming showcase.
 *
 * Mage-VL is an *event-gated* streaming model: a lightweight cognition gate
 * scores `p_speak = g(h_t)` per rolling window and stays SILENT on routine
 * content (only the ~free gate pass runs), invoking the full 5B VLM (System 2)
 * only when a response-worthy event completes. Meanwhile Mage-ViT keeps only
 * anchor (I) + motion-salient (P) patches, so even when the VLM does run it
 * consumes far fewer *visual* tokens than dense uniform frame sampling.
 *
 * These two independent savings axes are what the dashboard surfaces:
 *  1. Gate savings  — a SILENT window costs ~0 *generated* tokens.
 *  2. Codec savings — SPARSE visual tokens instead of a dense baseline.
 *
 * All functions are pure and operate on the per-window ledger rows described
 * in the implementation plan (`token_ledger`). They are UI-agnostic so the
 * same engine powers the webapp dashboard, the springboard API, and tests.
 */

/** The gate's decision for a single rolling window. */
export type GateDecision = 'silent' | 'speak';

/** Human-readable reason shown when the gate stays silent (no VLM run). */
export const SILENT_REASON = 'routine content — gate silent';

/** Default reason category when a silent window has no annotated reason. */
export const DEFAULT_SILENT_REASON = SILENT_REASON;

/** One per-window ledger row (matches `token_ledger` in the plan). */
export interface WindowEvent {
  /** Monotonic window index within the session. */
  seq: number;
  /** Window start (ms, epoch or session-relative). */
  tStart: number;
  /** Window end (ms). */
  tEnd: number;
  /** Gate score in [0, 1] for the window. */
  pSpeak: number;
  /** Gate decision. */
  decision: GateDecision;
  /** Sparse, codec-native visual tokens actually consumed this window. */
  tokensVisual: number;
  /** Dense / uniform-framing visual-token baseline for the same window. */
  tokensBaselineDense: number;
  /** System-2 output tokens produced (≈0 when the gate was silent). */
  tokensGenerated: number;
  /** Injected user prompt, if any. */
  prompt?: string;
  /** Structured/verbose text the VLM produced, if it ran. */
  responseText?: string;
  /** Optional annotated reason (otherwise derived from `decision`). */
  reason?: string;
}

/** Per-window token counters for a single ledger row. */
export interface WindowSavings {
  seq: number;
  decision: GateDecision;
  pSpeak: number;
  /** Tokens the VLM actually generated this window (≈0 when silent). */
  tokensGenerated: number;
  /** Sparse visual tokens this window. */
  tokensVisual: number;
  /** Dense baseline visual tokens this window. */
  tokensBaselineDense: number;
  /**
   * Codec-level tokens avoided = dense baseline − sparse visual
   * (the Mage-ViT sparsity saving for this window; 0 on negatives).
   */
  tokensSaved: number;
  /** Savings fraction for this window in [0, 1] (0 when no dense baseline). */
  savingsPct: number;
  /** Why the window was silent, or null when the VLM ran. */
  reason: string | null;
}

/** Live "tokens saved this window" headline for the most recent window. */
export interface LiveWindow {
  seq: number;
  decision: GateDecision;
  pSpeak: number;
  /** ≈0 when silent; the real generated total when the VLM ran. */
  tokensGenerated: number;
  tokensSaved: number;
  savingsPct: number;
  /** null when silent, else the speak reason/explainer. */
  reason: string | null;
  isSilent: boolean;
}

/** Session-cumulative totals across every window. */
export interface CumulativeSavings {
  windows: number;
  silentWindows: number;
  speakWindows: number;
  tokensVisualTotal: number;
  tokensBaselineDenseTotal: number;
  tokensGeneratedTotal: number;
  /** Codec-level tokens avoided over the session. */
  tokensSavedTotal: number;
  /** Savings % in [0, 1] = saved / dense baseline. */
  savingsPct: number;
}

/** One point of the p_speak sparkline. */
export interface SparklinePoint {
  t: number;
  pSpeak: number;
  decision: GateDecision;
}

/** Separate counters: billed stream time vs model compute avoided. */
export interface SessionCounters {
  /** Billed stream-minutes accumulated across windows. */
  streamMinutes: number;
  /** Model-compute tokens avoided (gate + codec), separate from minutes. */
  tokensAvoided: number;
  /** Tokens the VLM actually generated (≈0 on a mostly-static stream). */
  tokensGenerated: number;
  windows: number;
}

/** Clamp p_speak into [0, 1]. */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** Savings fraction for a window given sparse and dense visual tokens. */
export function windowSavingsPct(tokensVisual: number, tokensBaselineDense: number): number {
  if (!Number.isFinite(tokensBaselineDense) || tokensBaselineDense <= 0) return 0;
  const saved = tokensBaselineDense - tokensVisual;
  return clamp01(saved / tokensBaselineDense);
}

/**
 * Human-readable reason for a window.
 * - silent  -> `SILENT_REASON` ("routine content — gate silent") unless a
 *              more specific `event.reason` is supplied.
 * - speak   -> records that the VLM ran (System 2 engaged).
 */
export function whySilent(event: Pick<WindowEvent, 'decision' | 'pSpeak' | 'reason' | 'tokensGenerated'>): string | null {
  if (event.decision === 'speak') {
    return `p_speak=${clamp01(event.pSpeak).toFixed(3)} exceeded the speak threshold — System 2 invoked, generated ${event.tokensGenerated} tokens.`;
  }
  return event.reason ?? SILENT_REASON;
}

/** Per-window savings for one ledger row. */
export function windowSavings(event: WindowEvent): WindowSavings {
  const tokensSaved = Math.max(event.tokensBaselineDense - event.tokensVisual, 0);
  return {
    seq: event.seq,
    decision: event.decision,
    pSpeak: clamp01(event.pSpeak),
    tokensGenerated: event.decision === 'silent' ? Math.min(event.tokensGenerated, 0) : event.tokensGenerated,
    tokensVisual: event.tokensVisual,
    tokensBaselineDense: event.tokensBaselineDense,
    tokensSaved,
    savingsPct: windowSavingsPct(event.tokensVisual, event.tokensBaselineDense),
    reason: whySilent(event),
  };
}

/**
 * Live "tokens saved this window" for the most recent window.
 * A silent (mostly-static) window reports ~0 generated tokens and the
 * "routine content — gate silent" reason, which is the headline metric.
 */
export function liveWindow(events: readonly WindowEvent[]): LiveWindow {
  if (events.length === 0) {
    return {
      seq: 0, decision: 'silent', pSpeak: 0, tokensGenerated: 0,
      tokensSaved: 0, savingsPct: 0, reason: SILENT_REASON, isSilent: true,
    };
  }
  const last = events[events.length - 1];
  const w = windowSavings(last);
  return {
    seq: last.seq,
    decision: last.decision,
    pSpeak: w.pSpeak,
    tokensGenerated: w.tokensGenerated,
    tokensSaved: w.tokensSaved,
    savingsPct: w.savingsPct,
    reason: w.reason,
    isSilent: last.decision === 'silent',
  };
}

/** Session-cumulative savings totals (the savings % headline). */
export function cumulativeSavings(events: readonly WindowEvent[]): CumulativeSavings {
  let silent = 0;
  let speak = 0;
  let visual = 0;
  let dense = 0;
  let generated = 0;
  for (const e of events) {
    if (e.decision === 'silent') silent++;
    else speak++;
    visual += e.tokensVisual;
    dense += e.tokensBaselineDense;
    generated += e.decision === 'silent' ? 0 : e.tokensGenerated;
  }
  const saved = Math.max(dense - visual, 0);
  return {
    windows: events.length,
    silentWindows: silent,
    speakWindows: speak,
    tokensVisualTotal: visual,
    tokensBaselineDenseTotal: dense,
    tokensGeneratedTotal: generated,
    tokensSavedTotal: saved,
    savingsPct: dense > 0 ? Math.min(saved / dense, 1) : 0,
  };
}

/** p_speak series for the sparkline, with the silent/speak band on each point. */
export function sparklineSeries(events: readonly WindowEvent[]): SparklinePoint[] {
  return events.map((e) => ({
    t: e.tEnd,
    pSpeak: clamp01(e.pSpeak),
    decision: e.decision,
  }));
}

/**
 * Separate counters: billed stream-minutes vs model-compute tokens avoided.
 * streamMinutes meters billable time; tokensAvoided shows the model compute
 * saved inside that (mostly-static) time. They stay independent.
 */
export function sessionCounters(
  events: readonly WindowEvent[],
  nowMs: number = events.length > 0
    ? events[events.length - 1].tEnd + (events[events.length - 1].tEnd - events[events.length - 1].tStart)
    : Date.now(),
): SessionCounters {
  let minutes = 0;
  let avoided = 0;
  let generated = 0;
  for (const e of events) {
    const dur = Math.max(e.tEnd - e.tStart, 0);
    minutes += dur;
    avoided += Math.max(e.tokensBaselineDense - e.tokensVisual, 0);
    generated += e.decision === 'silent' ? 0 : e.tokensGenerated;
  }
  // Include the live (in-flight, not yet closed) window so the counter moves
  // while streaming: from the last closed window's end to `nowMs`.
  let liveMs = 0;
  if (events.length > 0) {
    const last = events[events.length - 1];
    liveMs = Math.max(nowMs - last.tEnd, 0);
  }
  minutes += liveMs;
  return {
    streamMinutes: minutes / 60000,
    tokensAvoided: avoided,
    tokensGenerated: generated,
    windows: events.length,
  };
}
