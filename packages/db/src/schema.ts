import {
  boolean,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

/** A stream session (one live stream being processed). */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("pending"),
  runnerId: uuid("runner_id"),
  prompt: text("prompt"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
});

/** A stored prompt revision for a session. */
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id),
    body: text("body").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    bySession: uniqueIndex("prompts_session_idx").on(t.sessionId, t.createdAt),
  })
);

/**
 * Per-window token ledger row (the core insight). `tokensVisual` is the sparse
 * codec-native count, `tokensBaselineDense` the analytic dense estimate, and
 * `tokensGenerated` the VLM-generated tokens (0 for a silent gate window).
 */
export const tokenLedger = pgTable("token_ledger", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  seq: integer("seq").notNull(),
  tStart: real("t_start").notNull(),
  tEnd: real("t_end").notNull(),
  pSpeak: real("p_speak").notNull(),
  decision: text("decision").notNull(), // 'silent' | 'speak'
  tokensVisual: integer("tokens_visual").notNull(),
  tokensBaselineDense: integer("tokens_baseline_dense").notNull(),
  tokensGenerated: integer("tokens_generated").notNull(),
  prompt: text("prompt"),
  responseText: text("response_text"),
});

/** Raw structured per-window events (the springboard event store). */
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  seq: integer("seq").notNull(),
  ts: timestamp("ts").notNull().defaultNow(),
  payload: jsonb("payload").notNull(),
});

/** A live stream being processed (the plan's stream_sessions). */
export const streamSessions = pgTable("stream_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id),
  source: text("source").notNull(), // 'webrtc' | 'file-sim' | 'file'
  videoPath: text("video_path"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
});

/** A per-GPU runner (one per 5090) plus its slot capacity/health. */
export const runners = pgTable("runners", {
  id: uuid("id").primaryKey().defaultRandom(),
  gpu: integer("gpu").notNull(),
  totalSlots: integer("total_slots").notNull(),
  freeSlots: integer("free_slots").notNull(),
  healthy: boolean("healthy").notNull().default(true),
  lastHeartbeat: timestamp("last_heartbeat"),
});
