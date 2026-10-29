import {
  denseBaselineTokens,
  frameCountInWindow,
} from "./baseline.js";
import { windowSavings } from "./savings.js";
import { parseRunnerTelemetryLine } from "./runner-telemetry.js";
import {
  EMPTY_SESSION_COUNTERS,
  type GateDecision,
  type SessionCounters,
  type WindowEvent,
} from "./types.js";

/**
 * Context needed to turn raw runner telemetry lines into token-savings
 * insights. `height`/`width` are the frame dimensions used for the analytic
 * baseline (post `max_pixels` cap); `effectiveFps` is the actual processed
 * frame rate (native codec fps for `--video_backend codec`, `--cur_fps` for
 * `--video_backend frames`).
 */
export interface LedgerContext {
  sessionId: string;
  height: number;
  width: number;
  effectiveFps: number;
}

/** A single per-window ledger row as consumed from the NDJSON feed. */
export interface TokenLedgerRow {
  seq: number;
  tStart: number;
  tEnd: number;
  pSpeak: number;
  decision: GateDecision;
  tokensVisual: number;
  tokensBaselineDense: number;
  tokensGenerated: number;
  windowSavings: number;
  responseText: string | null;
}

export interface LedgerSummary {
  sessionId: string;
  /** Stream seconds covered by observed windows (sum of window durations). */
  streamSeconds: number;
  savingsPct: number;
  counters: SessionCounters;
}

/**
 * Per-session token ledger: consumes the runner's per-window NDJSON telemetry
 * lines (`token_ledger`), computes the analytic dense baseline per window,
 * and tracks window/cumulative savings plus session counters.
 */
export class SessionLedger {
  private readonly rows: TokenLedgerRow[] = [];

  constructor(private readonly ctx: LedgerContext) {}

  get sessionId(): string {
    return this.ctx.sessionId;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  /**
   * Consume NDJSON telemetry lines. Returns the number of lines accepted;
   * blank or contract-invalid lines are skipped.
   */
  consume(lines: string[]): number {
    let accepted = 0;
    for (const line of lines) {
      const telemetry = parseRunnerTelemetryLine(line);
      if (!telemetry) continue;
      this.rows.push(this.toRow(telemetry));
      accepted += 1;
    }
    return accepted;
  }

  getRows(): TokenLedgerRow[] {
    return [...this.rows];
  }

  /**
   * Per-window insight events with running `cumulativeSavings` and
   * `sessionCounters` in observation order.
   */
  snapshot(): WindowEvent[] {
    const counters: SessionCounters = { ...EMPTY_SESSION_COUNTERS };
    let cumulativeSavings = 0;
    return this.rows.map((row) => {
      counters.windows += 1;
      if (row.decision === "silent") counters.silentWindows += 1;
      else counters.speakWindows += 1;
      counters.tokensVisualTotal += row.tokensVisual;
      counters.tokensBaselineDenseTotal += row.tokensBaselineDense;
      counters.tokensGeneratedTotal += row.tokensGenerated;
      counters.tokensSavedTotal += row.windowSavings;
      cumulativeSavings += row.windowSavings;
      return {
        sessionId: this.ctx.sessionId,
        seq: row.seq,
        tStart: row.tStart,
        tEnd: row.tEnd,
        pSpeak: row.pSpeak,
        decision: row.decision,
        tokensVisual: row.tokensVisual,
        tokensBaselineDense: row.tokensBaselineDense,
        tokensGenerated: row.tokensGenerated,
        windowSavings: row.windowSavings,
        cumulativeSavings,
        sessionCounters: { ...counters },
      };
    });
  }

  /** Aggregated session summary (drives the token-summary route). */
  summary(): LedgerSummary {
    const events = this.snapshot();
    const counters =
      events.length > 0
        ? { ...events[events.length - 1].sessionCounters }
        : { ...EMPTY_SESSION_COUNTERS };
    const streamSeconds = this.rows.reduce((acc, r) => acc + (r.tEnd - r.tStart), 0);
    return {
      sessionId: this.ctx.sessionId,
      streamSeconds,
      savingsPct:
        counters.tokensBaselineDenseTotal > 0
          ? counters.tokensSavedTotal / counters.tokensBaselineDenseTotal
          : 0,
      counters,
    };
  }

  private toRow(t: {
    window: number;
    tStart: number;
    tEnd: number;
    pSpeak: number;
    decision: GateDecision;
    tokensVisual: number;
    tokensGenerated: number;
    responseText: string | null;
  }): TokenLedgerRow {
    const framesInWindow = frameCountInWindow(
      t.tStart,
      t.tEnd,
      this.ctx.effectiveFps,
    );
    const tokensBaselineDense = denseBaselineTokens(
      framesInWindow,
      this.ctx.height,
      this.ctx.width,
    );
    return {
      seq: t.window,
      tStart: t.tStart,
      tEnd: t.tEnd,
      pSpeak: t.pSpeak,
      decision: t.decision,
      tokensVisual: t.tokensVisual,
      tokensBaselineDense,
      tokensGenerated: t.tokensGenerated,
      windowSavings: windowSavings(tokensBaselineDense, t.tokensVisual),
      responseText: t.responseText,
    };
  }
}
