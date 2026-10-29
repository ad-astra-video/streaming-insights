/**
 * Per-window savings arithmetic (Phase 0b decision, ADAAAA-7547).
 *
 *   tokensSaved  = max(tokensBaselineDense - tokensVisual, 0)
 *   savingsPct   = tokensSaved / tokensBaselineDense
 */

/** Codec-token savings for a window, floored at zero. */
export function windowSavings(
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
  return windowSavings(tokensBaselineDense, tokensVisual) / tokensBaselineDense;
}
