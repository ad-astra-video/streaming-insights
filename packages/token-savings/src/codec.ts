/**
 * Codec-token arithmetic (Phase 0b decision, ADAAAA-7547).
 *
 *   tokensSaved  = max(tokensBaselineDense - tokensVisual, 0)
 *   savingsPct   = tokensSaved / tokensBaselineDense
 *
 * These are the per-window primitives the NDJSON ledger pipeline
 * (`./ledger.ts`) folds into rows and session counters. The richer
 * per-window / per-session analytics engine lives in `./savings.ts`; both
 * coexist in this package and are exported from the package index.
 */

/** Codec-token savings for a window, floored at zero. */
export function codecTokensSaved(
  tokensBaselineDense: number,
  tokensVisual: number,
): number {
  return Math.max(tokensBaselineDense - tokensVisual, 0);
}

/** Savings fraction in `[0, 1]`; 0 when the baseline is zero. */
export function savingsPct(
  tokensBaselineDense: number,
  tokensVisual: number,
): number {
  if (tokensBaselineDense <= 0) return 0;
  return codecTokensSaved(tokensBaselineDense, tokensVisual) / tokensBaselineDense;
}
