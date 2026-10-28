export interface ServerConfig {
  port: number;
  nodeEnv: string;
  /** Postgres connection string. When unset (dev), the server boots PGlite. */
  databaseUrl?: string;
  /** Number of expected GPU runners (RUNNERS). */
  runners: number;
  /** Max concurrent streams per runner (STREAMS_PER_RUNNER). */
  streamsPerRunner: number;
  /** Total capacity (MAX_STREAMS). */
  maxStreams: number;
  /** Runner considered down when no heartbeat within this window (ms). */
  runnerHeartbeatTtlMs: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runners = parseInt(env.RUNNERS ?? "3", 10);
  const streamsPerRunner = parseInt(env.STREAMS_PER_RUNNER ?? "3", 10);
  const maxStreams = env.MAX_STREAMS ? parseInt(env.MAX_STREAMS, 10) : runners * streamsPerRunner;
  return {
    port: parseInt(env.PORT ?? "3100", 10),
    nodeEnv: env.NODE_ENV ?? "development",
    databaseUrl: env.DATABASE_URL || undefined,
    runners,
    streamsPerRunner,
    maxStreams,
    runnerHeartbeatTtlMs: parseInt(env.RUNNER_HEARTBEAT_TTL_MS ?? "15000", 10),
  };
}
