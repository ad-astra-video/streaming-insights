import { z } from "zod";

/**
 * The runner's per-window telemetry line (telemetry hook, Phase 0b decision,
 * ADAAAA-7547). One machine-readable NDJSON line per window:
 *
 * ```json
 * {"window":0,"tStart":0.0,"tEnd":8.0,"pSpeak":0.191,"decision":"silent","tokensVisual":40,"tokensGenerated":0,"responseText":null}
 * {"window":1,"tStart":8.0,"tEnd":16.0,"pSpeak":0.551,"decision":"speak","tokensVisual":312,"tokensGenerated":64,"responseText":"The video features ..."}
 * ```
 *
 * - `pSpeak` = `softmax(gate_logits at segment boundary)[:, 1]`
 * - `decision` = `silent` | `speak`
 * - `tokensVisual` = `int(segment["image_grid_thw"][:, 0].sum())`
 * - `tokensGenerated` = `model.generate(...)` output length - prompt length
 * - `responseText` = decoded caption (null on silence)
 */
export const RunnerWindowTelemetrySchema = z.object({
  window: z.number().int().min(0),
  tStart: z.number(),
  tEnd: z.number(),
  pSpeak: z.number().min(0).max(1),
  decision: z.enum(["silent", "speak"]),
  tokensVisual: z.number().int().min(0),
  tokensGenerated: z.number().int().min(0),
  responseText: z.string().nullable(),
});

export type RunnerWindowTelemetry = z.infer<typeof RunnerWindowTelemetrySchema>;

/**
 * Parse one NDJSON telemetry line. Returns the typed line, or `null` when the
 * line is blank or does not match the contract (malformed lines are skipped,
 * not fatal, so a partial feed does not wedge the consumer).
 */
export function parseRunnerTelemetryLine(
  line: string,
): RunnerWindowTelemetry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const result = RunnerWindowTelemetrySchema.safeParse(parsed);
  return result.success ? result.data : null;
}
