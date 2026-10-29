import {
  pgTable,
  uuid,
  text,
  integer,
  real,
  timestamp,
  jsonb,
  index,
} from "drizzle-orm/pg-core";

/**
 * The control-plane data model for the Mage-VL streaming showcase.
 *
 * Mirrors the highlights.live control server split: a control plane
 * (services/server + Postgres) owns sessions, prompts, the token ledger, the
 * structured event store, and runner health/capacity tracking. See the repo
 * plan (Phase 1) for the ledger/event row shapes.
 */

/** A GPU runner: one long-lived process bound to a single GPU (per 5090). */
export const runners = pgTable(
  "runners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Human-friendly runner name, e.g. "runner-0". */
    name: text("name").notNull(),
    /** CUDA_VISIBLE_DEVICES index this runner binds to. */
    gpuIndex: integer("gpu_index").notNull(),
    host: text("host").notNull(),
    /** healthy | degraded | down */
    status: text("status").notNull().default("healthy"),
    /** Max concurrent streams this runner can hold (STREAMS_PER_RUNNER). */
    capacity: integer("capacity").notNull(),
    /** Number of slots currently occupied by active stream sessions. */
    slotsUsed: integer("slots_used").notNull().default(0),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("runners_gpu_index_idx").on(table.gpuIndex)]
);

/** A high-level (user-facing) session. Initial showcase is a single anonymous session. */
export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("active"),
  title: text("title"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A live stream session being processed (dispatched to a runner slot). */
export const streamSessions = pgTable(
  "stream_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** active | ended | released */
    status: text("status").notNull().default("active"),
    /** Source of the stream: webrtc | file | sim. */
    source: text("source").notNull(),
    /** The runner slot reserved for this session (null before dispatch). */
    runnerId: uuid("runner_id").references(() => runners.id, { onDelete: "set null" }),
    sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("stream_sessions_runner_idx").on(table.runnerId),
    index("stream_sessions_status_idx").on(table.status),
  ]
);

/** A prompt injected into a stream session. */
export const prompts = pgTable(
  "prompts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamSessionId: uuid("stream_session_id")
      .notNull()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("prompts_stream_session_idx").on(table.streamSessionId)]
);

/** Per-window token ledger row (the token-savings instrumentation). */
export const tokenLedger = pgTable(
  "token_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamSessionId: uuid("stream_session_id")
      .notNull()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    /** Window sequence number within the session. */
    seq: integer("seq").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    /** Gate confidence that the window warrants a System-2 response (0..1). */
    pSpeak: real("p_speak"),
    /** silent | speak */
    decision: text("decision"),
    tokensVisual: integer("tokens_visual"),
    tokensBaselineDense: integer("tokens_baseline_dense"),
    tokensGenerated: integer("tokens_generated"),
    prompt: text("prompt"),
    responseText: text("response_text"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("token_ledger_session_idx").on(table.streamSessionId),
    index("token_ledger_session_seq_idx").on(table.streamSessionId, table.seq),
  ]
);

/** Structured per-window events (the "springboard" data-out contract), NDJSON-addressable. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    streamSessionId: uuid("stream_session_id")
      .notNull()
      .references(() => streamSessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    tStart: real("t_start").notNull(),
    tEnd: real("t_end").notNull(),
    /** { pSpeak, decision } */
    gate: jsonb("gate"),
    /** { visual, baselineDense, generated, savedVsBaseline } */
    tokens: jsonb("tokens"),
    prompt: text("prompt"),
    /** { type, text, structured? } */
    event: jsonb("event"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("events_session_idx").on(table.streamSessionId),
    index("events_session_seq_idx").on(table.streamSessionId, table.seq),
  ]
);

export const schema = {
  runners,
  sessions,
  streamSessions,
  prompts,
  tokenLedger,
  events,
};

// Inferred row types for the schema-typed services.
export type Runner = typeof runners.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type StreamSession = typeof streamSessions.$inferSelect;
export type Prompt = typeof prompts.$inferSelect;
export type TokenLedgerRow = typeof tokenLedger.$inferSelect;
export type Event = typeof events.$inferSelect;
