import { eq } from "drizzle-orm";
import type { Db } from "./db";
import { tokenLedger } from "./schema";

/**
 * Session-cumulative token summary, computed from the `token_ledger` rows for a
 * stream session. Field names mirror the token-savings `CumulativeSavings`
 * shape from the Phase 0b confirmed design; when no windows have been recorded
 * the summary is empty (every counter 0, `savingsPct` 0).
 */
export interface TokenSummary {
  windows: number;
  silentWindows: number;
  speakWindows: number;
  tokensVisualTotal: number;
  tokensBaselineDenseTotal: number;
  tokensGeneratedTotal: number;
  tokensSavedTotal: number;
  savingsPct: number;
}

export async function tokenSummary(
  db: Db,
  streamSessionId: string
): Promise<TokenSummary> {
  const rows = await db
    .select()
    .from(tokenLedger)
    .where(eq(tokenLedger.streamSessionId, streamSessionId));

  let silent = 0;
  let speak = 0;
  let visual = 0;
  let dense = 0;
  let generated = 0;
  for (const r of rows) {
    if (r.decision === "silent") silent++;
    else if (r.decision === "speak") speak++;
    visual += r.tokensVisual ?? 0;
    dense += r.tokensBaselineDense ?? 0;
    generated += r.decision === "silent" ? 0 : (r.tokensGenerated ?? 0);
  }
  const saved = Math.max(dense - visual, 0);
  return {
    windows: rows.length,
    silentWindows: silent,
    speakWindows: speak,
    tokensVisualTotal: visual,
    tokensBaselineDenseTotal: dense,
    tokensGeneratedTotal: generated,
    tokensSavedTotal: saved,
    savingsPct: dense > 0 ? Math.min(saved / dense, 1) : 0,
  };
}
