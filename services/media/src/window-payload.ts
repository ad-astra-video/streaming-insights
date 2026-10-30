// WindowOutcome + timing -> the two payloads the control server persists for a
// closed window: the token-ledger row and the springboard event.
//
// Kept as a pure function so the contract can be unit-tested without a live
// media session, and so both payloads are built from ONE normalized outcome
// (a ledger row and its event must never disagree about a window's tokens).
import type { EventPayload, LedgerWindowPayload } from "./control-client.js";
import type { WindowOutcome } from "./runner-client.js";

/** Window identity/timing as produced by the window accumulator. */
export interface WindowSpan {
  seq: number;
  tStart: number;
  tEnd: number;
}

/**
 * Whole-token count for a persisted column.
 *
 * `token_ledger.tokens_*` are `integer` columns (`packages/db/src/schema.ts`)
 * and a runner's usage block is not guaranteed to be integral — a fractional
 * count made the control write throw and returned a 500, which silently dropped
 * the window from the ledger (the dashboard then under-reported and the webapp
 * flipped to `Error`). Normalize once here so a runner can never wedge the
 * write path, and never emit a negative or non-finite count.
 */
function tokenCount(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

/**
 * Build the ledger row + springboard event for one window.
 *
 * Contract points that are easy to regress:
 *  - `savedVsBaseline` is a FRACTION in [0,1], never the saved-token count.
 *  - A silent window reports 0 generated tokens even if the runner speculated.
 *  - `tStart`/`tEnd` are session-relative seconds, not raw epoch seconds.
 */
export function buildWindowPayloads(
  outcome: WindowOutcome,
  span: WindowSpan,
  prompt: string | undefined
): { ledger: LedgerWindowPayload; event: EventPayload } {
  const generated = outcome.decision === "silent" ? 0 : tokenCount(outcome.tokensGenerated);
  const tokensVisual = tokenCount(outcome.tokensVisual);
  const tokensBaselineDense = tokenCount(outcome.tokensBaselineDense);
  const saved = Math.max(tokensBaselineDense - tokensVisual, 0);
  const savedVsBaseline = tokensBaselineDense > 0 ? Math.min(saved / tokensBaselineDense, 1) : 0;

  const ledger: LedgerWindowPayload = {
    seq: span.seq,
    tStart: span.tStart,
    tEnd: span.tEnd,
    pSpeak: outcome.pSpeak,
    decision: outcome.decision,
    tokensVisual,
    tokensBaselineDense,
    tokensGenerated: generated,
    prompt,
    responseText: outcome.responseText ?? undefined,
  };

  const event: EventPayload = {
    seq: span.seq,
    tStart: span.tStart,
    tEnd: span.tEnd,
    gate: { pSpeak: outcome.pSpeak, decision: outcome.decision },
    tokens: { visual: tokensVisual, baselineDense: tokensBaselineDense, generated, savedVsBaseline },
    prompt,
    event: {
      type: outcome.decision === "speak" ? "response" : "silent",
      text: outcome.responseText,
    },
  };

  return { ledger, event };
}
