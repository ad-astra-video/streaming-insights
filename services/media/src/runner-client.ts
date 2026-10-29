import type { CodecWindow } from "./windows.js";

/** Per-window outcome the Mage-VL runner returns, matching the Phase 0b
 *  telemetry contract: gate (pSpeak + decision), sparse/dense visual token
 *  counts, generated tokens, and the response text (null on silence). */
export interface WindowOutcome {
  pSpeak: number;
  decision: "silent" | "speak";
  tokensVisual: number;
  tokensBaselineDense: number;
  tokensGenerated: number;
  responseText: string | null;
}

export interface MageRunnerClient {
  driveWindow(window: CodecWindow, prompt?: string): Promise<WindowOutcome>;
}

/** HTTP Mage-VL runner client (Phase 3 backend). POSTs one window to the
 *  runner's OpenAI-compatible streaming endpoint and reads back the telemetry
 *  line. Replaced by the real SGLang `feat/mage-vl` serving runtime. */
export class HttpRunnerClient implements MageRunnerClient {
  /** Base URL without a trailing slash or a trailing `/v1` version segment:
   *  the window route appends `/v1/mage/window`, and deployed env sets
   *  RUNNER_BASE_URL=http://host:port/v1 (OpenAI-compatible base), which used
   *  to produce `/v1/v1/mage/window` -> 404. */
  private readonly base: string;

  constructor(base: string) {
    this.base = base.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
  }

  async driveWindow(window: CodecWindow, prompt?: string): Promise<WindowOutcome> {
    const res = await fetch(`${this.base}/v1/mage/window`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        seq: window.seq,
        tStart: window.tStart,
        tEnd: window.tEnd,
        prompt: prompt ?? null,
        frames: window.frames.map((f) => ({ ts: f.ts, jpeg: f.jpeg.toString("base64") })),
      }),
    });
    if (!res.ok) {
      throw new Error(`runner returned ${res.status}`);
    }
    const body = (await res.json()) as any;
    if (
      typeof body.pSpeak !== "number" ||
      (body.decision !== "silent" && body.decision !== "speak") ||
      typeof body.tokensVisual !== "number" ||
      typeof body.tokensBaselineDense !== "number" ||
      typeof body.tokensGenerated !== "number"
    ) {
      throw new Error("runner returned malformed window outcome");
    }
    return {
      pSpeak: body.pSpeak,
      decision: body.decision,
      tokensVisual: body.tokensVisual,
      tokensBaselineDense: body.tokensBaselineDense,
      tokensGenerated: body.tokensGenerated,
      responseText: typeof body.responseText === "string" ? body.responseText : null,
    };
  }
}

export interface MockRunnerOptions {
  gateThreshold?: number;
  denseTokensPerFrame?: number;
  sparseTokensPerFrame?: number;
  speakTokensPerWindow?: number;
  /** Gain from frame-size coefficient-of-variation -> pSpeak. Default 2.2. */
  motionGain?: number;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function std(xs: number[]): number {
  if (xs.length === 0) return 0;
  const m = mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / xs.length;
  return Math.sqrt(v);
}
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/**
 * In-process mock Mage-VL runner. It lets the ingest -> window -> dispatch ->
 * event pipeline run end to end with no GPU (Phases 1-2 verification) by
 * deriving a plausible per-window outcome from the frames themselves:
 *  - `pSpeak` ~ coefficient-of-variation of the decoded frame JPEG sizes
 *    (a changed/moving window varies more than a static one), scaled by a gain.
 *  - `tokensVisual` / `tokensBaselineDense` = sparse / dense analytic patch
 *    counts for the window's frames (Phase 0b §3 dense-baseline method).
 *  - a `speak` window produces `tokensGenerated` + a response text; a `silent`
 *    window produces ~0 generated tokens and null text (the gate-savings axis).
 */
export class MockRunnerClient implements MageRunnerClient {
  constructor(private opts: MockRunnerOptions = {}) {}

  async driveWindow(window: CodecWindow, prompt?: string): Promise<WindowOutcome> {
    const n = window.frames.length;
    const sizes = window.frames.map((f) => f.jpeg.length);
    const m = mean(sizes);
    const s = std(sizes);
    const cv = m > 0 ? s / m : 0;
    const pSpeak = clamp01(cv * (this.opts.motionGain ?? 2.2));
    const threshold = this.opts.gateThreshold ?? 0.5;
    const decision: "silent" | "speak" = pSpeak >= threshold ? "speak" : "silent";

    const dense = this.opts.denseTokensPerFrame ?? 576;
    const sparse = this.opts.sparseTokensPerFrame ?? 129;
    const speakTokens = this.opts.speakTokensPerWindow ?? 48;

    const tokensVisual = n * sparse;
    const tokensBaselineDense = n * dense;
    const tokensGenerated = decision === "speak" ? speakTokens : 0;
    const responseText =
      decision === "speak"
        ? `[window ${window.seq}] ${prompt ? prompt + " — " : ""}the stream changed (p_speak=${pSpeak.toFixed(2)}); System 2 engaged.`
        : null;

    return { pSpeak, decision, tokensVisual, tokensBaselineDense, tokensGenerated, responseText };
  }
}
