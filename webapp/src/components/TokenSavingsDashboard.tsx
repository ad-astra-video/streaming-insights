import { deriveDashboard, explainWindow } from "../lib/dashboard";
import type { StreamWindowEvent } from "@streaming-insights/shared";

/**
 * Token-savings dashboard (Phase 5). Renders from the per-window event list
 * using the pure derivation in `lib/dashboard`:
 *
 *  - a live "tokens saved this window" counter with a why-silent/why-speak
 *    explainer for the most recent window,
 *  - cumulative savings % ,
 *  - a p_speak sparkline with silent vs speak bands,
 *  - stream-minutes and tokens-avoided as two separate counters.
 */

/** Fixed sparkline canvas size; the series is normalized to it. */
const SPARK_W = 320;
const SPARK_H = 64;
const SPARK_PAD = 4;

function Sparkline({ events }: { events: StreamWindowEvent[] }) {
  if (events.length === 0) return null;

  // Quarters of the raw p_speak range to place the 0.5 gate threshold line.
  const y = (pSpeak: number) =>
    SPARK_H - SPARK_PAD - (pSpeak * (SPARK_H - SPARK_PAD * 2));
  const x = (i: number) =>
    SPARK_PAD + (i / Math.max(events.length - 1, 1)) * (SPARK_W - SPARK_PAD * 2);

  const thresholdY = y(0.5);

  const linePoints = events
    .map((e, i) => `${x(i).toFixed(1)},${y(e.gate.pSpeak).toFixed(1)}`)
    .join(" ");

  return (
    <svg
      className="sparkline"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      role="img"
      aria-label={`p_speak sparkline across ${events.length} windows, silent vs speak`}
      preserveAspectRatio="none"
    >
      {/* silent vs speak bands behind the line */}
      {events.map((e, i) => {
        const bandX = x(i);
        const bandW =
          events.length === 1
            ? SPARK_W - SPARK_PAD * 2
            : SPARK_W / (events.length - 1);
        return (
          <rect
            key={e.seq}
            className={`spark-band ${e.gate.decision}`}
            x={bandX}
            y={0}
            width={bandW}
            height={SPARK_H}
          />
        );
      })}

      {/* gate threshold reference line at pSpeak = 0.5 */}
      <line
        className="spark-threshold"
        x1={SPARK_PAD}
        y1={thresholdY}
        x2={SPARK_W - SPARK_PAD}
        y2={thresholdY}
      />

      {/* p_speak series */}
      <polyline className="spark-line" points={linePoints} fill="none" />
    </svg>
  );
}

export function TokenSavingsDashboard({
  events,
}: {
  events: StreamWindowEvent[];
}) {
  const { metrics, streamMinutes, tokensAvoided, spark, latest } =
    deriveDashboard(events);

  const savedPct = Math.round(metrics.savedVsBaseline * 100);
  const latestExplain = latest ? explainWindow(latest) : null;
  // Live per-window savings for the most recent window: saved tokens + reason.
  const latestSaved = latest
    ? Math.round(latest.tokens.savedVsBaseline * latest.tokens.baselineDense)
    : 0;
  const latestGenerated = latest?.tokens.generated ?? 0;

  return (
    <div className="dashboard">
      <div className="metric-highlight">
        <p className="metric-highlight-label">Cumulative savings vs dense baseline</p>
        <p className="metric-highlight-value">{savedPct}%</p>
        <p className="metric-highlight-sub">
          {metrics.tokensSavedTotal} tokens avoided across {metrics.windows}{" "}
          windows
        </p>
      </div>

      {/* Live "tokens saved this window" counter */}
      {latest ? (
        <div className="metric-highlight metric-highlight-window">
          <p className="metric-highlight-label">This window</p>
          <p className="metric-highlight-value">
            {latestSaved} <span className="metric-unit">tokens saved</span>
          </p>
          <p
            className={`metric-highlight-sub ${
              latest.gate.decision === "silent" ? "is-silent" : "is-speak"
            }`}
          >
            {latestExplain?.headline}
            <span className="metric-detail"> · {latestExplain?.detail}</span>
          </p>
          <p className="metric-highlight-sub">
            generated {latestGenerated} tokens (gate {latest.gate.decision})
          </p>
        </div>
      ) : (
        <div className="state-block">
          <p className="state-title">No windows yet</p>
          <p className="state-body">
            Start a source — per-window gate decisions and token savings stream
            in here as they happen.
          </p>
        </div>
      )}

      {/* p_speak sparkline with silent vs speak bands */}
      <div className="dashboard-section">
        <div className="dashboard-label-row">
          <span className="metric-label">p_speak</span>
          <span className="dashboard-legend">
            <span className="legend-key legend-silent">silent</span>
            <span className="legend-key legend-speak">speak</span>
          </span>
        </div>
        {spark.length > 0 ? (
          <Sparkline events={events} />
        ) : (
          <div className="state-block empty-spark">
            <p className="state-body">No windows yet — sparkline appears here.</p>
          </div>
        )}
      </div>

      {/* Two separate counters: stream minutes vs tokens avoided */}
      <div className="dashboard-counters">
        <div className="metric-line">
          <span className="metric-label">Stream minutes</span>
          <span className="metric-value">{streamMinutes.toFixed(1)}</span>
        </div>
        <div className="metric-line">
          <span className="metric-label">Tokens avoided</span>
          <span className="metric-value">{tokensAvoided}</span>
        </div>
        <div className="metric-line">
          <span className="metric-label">Silent windows</span>
          <span className="metric-value">{metrics.silentWindows}</span>
        </div>
        <div className="metric-line">
          <span className="metric-label">Generated tokens</span>
          <span className="metric-value">{metrics.tokensGeneratedTotal}</span>
        </div>
      </div>
    </div>
  );
}
