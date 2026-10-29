import type { StreamWindowEvent } from "@streaming-insights/shared";

/** Event names surfaced on the live SSE feed. */
export const EVENT_TYPES = {
  WINDOW: "window",
  SESSION: "session",
} as const;

/** A window event as pushed over the session SSE/NDJSON feed. */
export type WindowEvent = {
  type: typeof EVENT_TYPES.WINDOW;
  seq: number;
  ts: number;
  data: StreamWindowEvent;
};

/** A session lifecycle event. */
export type SessionEvent = {
  type: typeof EVENT_TYPES.SESSION;
  sessionId: string;
  status: "pending" | "streaming" | "ended" | "failed";
  ts: number;
};

/** The union of live feed events. */
export type FeedEvent = WindowEvent | SessionEvent;
