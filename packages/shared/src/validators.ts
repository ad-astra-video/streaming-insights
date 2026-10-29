import { z } from "zod";

/**
 * The per-window event emitted by the runner/media server, the core data-out
 * contract ("springboard"). This mirrors the plan's NDJSON event schema and is
 * the shape the token-savings dashboard consumes.
 */
export const StreamWindowEventSchema = z.object({
  sessionId: z.string(),
  seq: z.number().int(),
  tStart: z.number(),
  tEnd: z.number(),
  gate: z.object({
    pSpeak: z.number().min(0).max(1),
    decision: z.enum(["silent", "speak"]),
  }),
  tokens: z.object({
    visual: z.number().int(),
    baselineDense: z.number().int(),
    generated: z.number().int(),
    /** 1 - visual / baselineDense, i.e. the codec-token savings fraction. */
    savedVsBaseline: z.number(),
  }),
  prompt: z.string().optional(),
  event: z
    .object({
      type: z.enum(["response"]),
      text: z.string(),
      structured: z.record(z.unknown()).optional(),
    })
    .optional(),
});
export type StreamWindowEvent = z.infer<typeof StreamWindowEventSchema>;

/** A stream session as persisted/returned by the control server. */
export const StreamSessionSchema = z.object({
  id: z.string(),
  status: z.enum(["pending", "streaming", "ended", "failed"]),
  runnerId: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
});
export type StreamSession = z.infer<typeof StreamSessionSchema>;

/** A runner (one per 5090) plus its live slot usage. */
export const RunnerSchema = z.object({
  id: z.string(),
  gpu: z.number().int(),
  totalSlots: z.number().int(),
  freeSlots: z.number().int(),
  healthy: z.boolean(),
  lastHeartbeat: z.string().nullable(),
});
export type Runner = z.infer<typeof RunnerSchema>;
