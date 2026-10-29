export interface MediaConfig {
  port: number;
  nodeEnv: string;
  /** Public origin of this media server (LB / Cloudflare front), used for the
   *  browser-reachable RTC signaling origin + full WS ingest URL. */
  publicBaseUrl?: string;
  /** Control server base URL (services/server) the media server POSTs sessions,
   *  windows and events to, and reserves runner slots against. */
  controlBase: string;
  /** Real Mage-VL runner base URL (Phase 3). When unset the media server uses
   *  the in-process mock runner so the ingest->window->dispatch->event path is
   *  testable without a GPU. */
  runnerBase?: string;
  /** When true (default when runnerBase is unset) dispatch to the MockRunner. */
  mockRunner: boolean;
  /** WebRTC ingest JPEG sample cadence (fps) decoded by the media server. */
  sampleFps: number;
  /** Number of decoded frames per dispatching window (the codec segment). The
   *  MockRunner and the window/ledger telemetry are defined per window, so
   *  `windowFrames` bounds a window regardless of wall-clock rate. Default 2. */
  windowFrames: number;
  /** Gate threshold the runner uses to decide silent vs speak. */
  gateThreshold: number;
  /** Mock-runner token constants (analytic dense baseline per Phase 0b §3). */
  denseTokensPerFrame: number;
  sparseTokensPerFrame: number;
  speakTokensPerWindow: number;
  /** Runner considered gone when no heartbeat within this window (ms). */
  runnerHeartbeatTtlMs: number;
  /** How long (ms) a session stays open after its last browser disconnects. */
  reconnectGraceMs?: number;
  /** How long (ms) a provisioned session may sit with no client before the
   *  runner slot is released. */
  provisionNoClientMs?: number;
  /** ICE servers (STUN/TURN) for WebRTC ingest. */
  rtcIceServers?: { urls: string | string[]; username?: string; credential?: string }[];
}

export function loadMediaConfig(env: NodeJS.ProcessEnv = process.env): MediaConfig {
  const controlBase = env.CONTROL_BASE_URL || "";
  const runnerBase = env.RUNNER_BASE_URL || undefined;
  return {
    port: parseInt(env.PORT ?? "4070", 10),
    nodeEnv: env.NODE_ENV ?? "development",
    publicBaseUrl: env.MEDIA_PUBLIC_BASE_URL || undefined,
    controlBase,
    runnerBase,
    mockRunner: runnerBase ? env.MOCK_RUNNER !== "false" : true,
    sampleFps: parseFloat(env.RTC_SAMPLE_FPS ?? "1"),
    windowFrames: parseInt(env.WINDOW_FRAMES ?? "2", 10),
    gateThreshold: parseFloat(env.GATE_THRESHOLD ?? "0.5"),
    denseTokensPerFrame: parseInt(env.DENSE_TOKENS_PER_FRAME ?? "576", 10),
    sparseTokensPerFrame: parseInt(env.SPARSE_TOKENS_PER_FRAME ?? "129", 10),
    speakTokensPerWindow: parseInt(env.SPEAK_TOKENS_PER_WINDOW ?? "48", 10),
    runnerHeartbeatTtlMs: parseInt(env.RUNNER_HEARTBEAT_TTL_MS ?? "15000", 10),
    reconnectGraceMs: env.MEDIA_RECONNECT_GRACE_MS ? parseInt(env.MEDIA_RECONNECT_GRACE_MS, 10) : undefined,
    provisionNoClientMs: env.MEDIA_PROVISION_NO_CLIENT_MS
      ? parseInt(env.MEDIA_PROVISION_NO_CLIENT_MS, 10)
      : undefined,
    rtcIceServers: env.RTC_ICE_SERVERS ? parseIceServers(env.RTC_ICE_SERVERS) : undefined,
  };
}

function parseIceServers(raw: string): { urls: string | string[] }[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((urls) => ({ urls }));
}
