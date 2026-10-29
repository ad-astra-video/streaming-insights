import { asc, eq } from "drizzle-orm";
import type { Db } from "./db";
import { tokenLedger } from "./schema";
import { CustomError, getStreamSession } from "./runners";

/** One per-window token-ledger row, matching the Phase 0b telemetry contract. */
export interface RecordWindowInput {
  /** Monotonic window index within the session. */
  seq: number;
  /** Window start (seconds, session-relative per the NDJSON contract). */
  tStart: number;
  /** Window end (seconds). */
  tEnd: number;
  /** Gate score in [0, 1]. */
  pSpeak?: number;
  /** Gate decision. */
  decision?: "silent" | "speak";
  /** Sparse, codec-native visual tokens actually consumed this window. */
  tokensVisual?: number;
  /** Dense / uniform-framing visual-token baseline for the same window. */
  tokensBaselineDense?: number;
  /** System-2 output tokens produced (~0 when the gate was silent). */
  tokensGenerated?: number;
  /** Injected user prompt, if any. */
  prompt?: string;
  /** Decoded generated caption (null on silence). */
  responseText?: string;
}

/**
 * Append a per-window ledger row for a stream session (the NDJSON telemetry
 * line persisted to the control-plane token ledger). The token-savings engine
 * consumes exactly these fields.
 */
export async function recordWindow(
  db: Db,
  streamSessionId: string,
  input: RecordWindowInput
): Promise<typeof tokenLedger.$inferSelect> {
  const session = await getStreamSession(db, streamSessionId);
  if (!session) throw new CustomError(404, `Stream session not found: ${streamSessionId}`);
  if (session.status !== "active") {
    throw new CustomError(409, `Stream session ${streamSessionId} is not active`);
  }

  const [row] = await db
    .insert(tokenLedger)
    .values({ streamSessionId, ...input })
    .returning();
  return row;
}

/** List the ledger rows for a session in window order. */
export async function listWindows(
  db: Db,
  streamSessionId: string
): Promise<typeof tokenLedger.$inferSelect[]> {
  return db
    .select()
    .from(tokenLedger)
    .where(eq(tokenLedger.streamSessionId, streamSessionId))
    .orderBy(asc(tokenLedger.seq));
}
