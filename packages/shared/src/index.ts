export * from "./constants.js";
export * from "./validators.js";
export * from "./contract.js";

import { API_PREFIX } from "./constants.js";

/** Public springboard route constants for the control server. */
export const ROUTES = {
  /** SSE live per-window events for a session. */
  sessionEvents: (sessionId: string) =>
    `${API_PREFIX}/sessions/${sessionId}/events`,
  /** NDJSON batch/offline per-window feed. */
  sessionEventsNdjson: (sessionId: string) =>
    `${API_PREFIX}/sessions/${sessionId}/events.ndjson`,
  /** Aggregated token summary for a session. */
  sessionTokenSummary: (sessionId: string) =>
    `${API_PREFIX}/sessions/${sessionId}/token-summary`,
  /** JSON Schema for the event contract. */
  schema: `${API_PREFIX}/schema`,
  health: `${API_PREFIX}/health`,
  /** Runtime wiring the browser needs (public media origin for ingest). */
  config: `${API_PREFIX}/config`,
} as const;
