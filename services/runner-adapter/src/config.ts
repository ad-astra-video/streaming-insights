export interface AdapterConfig {
  port: number;
  /** OpenAI-compatible base of the Mage-VL SGLang server, including the `/v1`
   *  version segment (e.g. `http://192.168.1.151:30000/v1`). The adapter appends
   *  `/chat/completions` to it. */
  upstream: string;
  /** Served model id the SGLang runtime exposes (GET /v1/models). */
  model: string;
  /** pSpeak at or above which the window is a `speak` decision. */
  gateThreshold: number;
  /** Dense baseline visual tokens per frame, used for the savings ledger's
   *  `tokensBaselineDense` (Phase 0b analytic baseline: 576 tokens/frame). */
  denseTokensPerFrame: number;
  /** Only the most recent N frames of a window are sent to the model. */
  maxFrames: number;
  maxTokens: number;
  temperature: number;
  requestTimeoutMs: number;
}

function int(v: string | undefined, fallback: number): number {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(v: string | undefined, fallback: number): number {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : fallback;
}

export function loadAdapterConfig(env: NodeJS.ProcessEnv = process.env): AdapterConfig {
  return {
    port: int(env.PORT, 4180),
    upstream: (env.RUNNER_UPSTREAM ?? "http://127.0.0.1:30000/v1").replace(/\/+$/, ""),
    model: env.RUNNER_MODEL ?? "microsoft/Mage-VL",
    gateThreshold: float(env.GATE_THRESHOLD, 0.5),
    denseTokensPerFrame: int(env.DENSE_TOKENS_PER_FRAME, 576),
    maxFrames: int(env.MAX_FRAMES_PER_WINDOW, 4),
    maxTokens: int(env.RUNNER_MAX_TOKENS, 128),
    temperature: float(env.RUNNER_TEMPERATURE, 0),
    requestTimeoutMs: int(env.RUNNER_TIMEOUT_MS, 60000),
  };
}
