import type { Db } from "./db";
import { prompts } from "./schema";
import { CustomError, getStreamSession } from "./runners";

/**
 * Persist a user/operator prompt injected into a live stream session. Truncated
 * text is not allowed: the incoming caption/system prompt is stored verbatim.
 */
export async function persistPrompt(
  db: Db,
  streamSessionId: string,
  text: string
): Promise<typeof prompts.$inferSelect> {
  const session = await getStreamSession(db, streamSessionId);
  if (!session) throw new CustomError(404, `Stream session not found: ${streamSessionId}`);

  const [row] = await db
    .insert(prompts)
    .values({ streamSessionId, text })
    .returning();
  return row;
}
