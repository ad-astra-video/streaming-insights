import type { StreamWindowEvent } from "@streaming-insights/shared";

/**
 * Synthetic "Demo" live source. It models the pinned Mage-VL runtime behavior:
 * an ~8s window produces a per-window event with a gate decision (mostly
 * `silent` on routine content, occasionally `speak`), codec-native sparse
 * visual tokens vs. an analytic dense baseline, and ~0 generated tokens on a
 * silent window. This lets the webapp's primary flow (source -> prompt ->
 * results) be demonstrated end to end in the browser without the media/GPU
 * pipeline.
 */

export interface SimFeedConfig {
  sessionId: string;
  /** Seconds per window (matches the pinned 8s streaming runtime). */
  windowSec?: number;
  /** Inject an RNG for deterministic tests. */
  rand?: () => number;
}

const DEFAULT_WINDOW_SEC = 8;

export class SimFeed {
  private readonly sessionId: string;
  private readonly windowSec: number;
  private readonly rand: () => number;
  private seq = 0;
  private t = 0;

  constructor(cfg: SimFeedConfig) {
    this.sessionId = cfg.sessionId;
    this.windowSec = cfg.windowSec ?? DEFAULT_WINDOW_SEC;
    this.rand = cfg.rand ?? Math.random;
  }

  /** Produce the next window event for the simulated stream. */
  next(prompt?: string): StreamWindowEvent {
    // Roughly 1 in 5 windows is an eventful "speak" window; the rest are
    // routine/silent, which is exactly the token-savings story.
    const speak = this.rand() >= 0.8;
    const pSpeak = speak ? 0.5 + this.rand() * 0.45 : this.rand() * 0.4;
    const decision = speak ? "speak" : "silent";

    const tStart = this.t;
    const tEnd = tStart + this.windowSec;
    this.t = tEnd;

    const framesInWindow = Math.round(this.windowSec * 30); // ~30fps
    // Analytic dense baseline: frames * (16x16 patch grid heuristic).
    const baselineDense = framesInWindow * 4 * 4;
    const visual = Math.max(1, Math.round(baselineDense * (0.18 + this.rand() * 0.15)));
    const generated = speak ? 40 + Math.round(this.rand() * 120) : 0;
    const savedVsBaseline =
      baselineDense > 0 ? Math.min(1 - visual / baselineDense, 1) : 0;

    const event: StreamWindowEvent = {
      sessionId: this.sessionId,
      seq: this.seq,
      tStart,
      tEnd,
      gate: { pSpeak: Number(pSpeak.toFixed(3)), decision },
      tokens: {
        visual,
        baselineDense,
        generated,
        savedVsBaseline: Number(savedVsBaseline.toFixed(3)),
      },
      ...(prompt ? { prompt } : {}),
      ...(speak
        ? {
            event: {
              type: "response" as const,
              text: `Response to "${prompt?.trim() || "this stream"}": a noteworthy moment just passed and the model flagged it.`,
            },
          }
        : {}),
    };

    this.seq += 1;
    return event;
  }

  reset(): void {
    this.seq = 0;
    this.t = 0;
  }
}

/** How often the sim source surfaces a new synthetic window (ms). */
export const SIM_EMIT_MS = 2000;
