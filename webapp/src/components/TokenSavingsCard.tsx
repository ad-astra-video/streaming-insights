import type { TokenMetrics } from "../lib/metrics";

export function TokenSavingsCard({ metrics }: { metrics: TokenMetrics }) {
  const savedPct = Math.round(metrics.savedVsBaseline * 100);
  const plainLabel =
    metrics.silentWindows > 0 ? "routine content — gate stayed silent" : "no windows yet";

  return (
    <div>
      <div className="metric-highlight">
        <p className="metric-highlight-label">
          Tokens saved vs dense baseline
        </p>
        <p className="metric-highlight-value">{savedPct}%</p>
        <p className="metric-highlight-sub">
          {metrics.tokensSavedTotal} tokens avoided across {metrics.windows}{" "}
          windows · {plainLabel}
        </p>
      </div>
      <div className="metric-line">
        <span className="metric-label">Silent windows</span>
        <span className="metric-value">{metrics.silentWindows}</span>
      </div>
      <div className="metric-line">
        <span className="metric-label">Model responded</span>
        <span className="metric-value">{metrics.speakWindows}</span>
      </div>
      <div className="metric-line">
        <span className="metric-label">Generated tokens</span>
        <span className="metric-value">{metrics.tokensGeneratedTotal}</span>
      </div>
      <div className="metric-line">
        <span className="metric-label">Visual tokens</span>
        <span className="metric-value">{metrics.tokensVisualTotal}</span>
      </div>
    </div>
  );
}
