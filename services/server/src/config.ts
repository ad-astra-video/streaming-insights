import { RUNNERS, STREAMS_PER_RUNNER } from "@streaming-insights/shared";

export interface ServerConfig {
  port: number;
  nodeEnv: string;
  /** Postgres connection string. When unset (dev/test), the server boots PGlite. */
  databaseUrl?: string;
  runners: number;
  streamsPerRunner: number;
  maxStreams: number;
  /** Runner considered down when no heartbeat within this window (ms). */
  runnerHeartbeatTtlMs: number;
  /** Live SSE feed poll interval (ms) — how often the server checks the event table. */
  ssePollMs: number;
  /** Public media origin handed to the browser for WebRTC signaling / WSS
   *  ingest (never the docker-internal hostname). */
  mediaPublicBaseUrl?: string;
  /** Public control origin (this server), for same-origin/link building. */
  publicBaseUrl?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runners = parseInt(env.RUNNERS ?? String(RUNNERS), 10);
  const streamsPerRunner = parseInt(env.STREAMS_PER_RUNNER ?? String(STREAMS_PER_RUNNER), 10);
  const maxStreams = env.MAX_STREAMS ? parseInt(env.MAX_STREAMS, 10) : runners * streamsPerRunner;
  return {
    port: parseInt(env.PORT ?? "3100", 10),
    nodeEnv: env.NODE_ENV ?? "development",
    databaseUrl: env.DATABASE_URL || undefined,
    runners,
    streamsPerRunner,
    maxStreams,
    runnerHeartbeatTtlMs: parseInt(env.RUNNER_HEARTBEAT_TTL_MS ?? "15000", 10),
    ssePollMs: parseInt(env.SSE_POLL_MS ?? "1000", 10),
    mediaPublicBaseUrl: env.MEDIA_PUBLIC_BASE_URL || undefined,
    publicBaseUrl: env.PUBLIC_BASE_URL || undefined,
  };
}
