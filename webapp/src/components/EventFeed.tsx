import type { StreamWindowEvent } from "@streaming-insights/shared";

export function EventFeed({ events }: { events: StreamWindowEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="state-block">
        <p className="state-title">No events yet</p>
        <p className="state-body">
          Start a source and set a prompt — per-window gate decisions and model
          responses stream in here as they happen.
        </p>
      </div>
    );
  }

  return (
    <div className="feed" aria-live="polite">
      {events.map((e) => {
        const savedPct = Math.round(e.tokens.savedVsBaseline * 100);
        return (
          <article key={e.seq} className="event">
            <span className={`event-gate ${e.gate.decision}`}>
              {e.gate.decision}
            </span>
            <div className="event-body">
              <div className="event-meta">
                window #{e.seq} · {e.tStart.toFixed(1)}s–{e.tEnd.toFixed(1)}s ·
                pSpeak {e.gate.pSpeak.toFixed(2)}
              </div>
              {e.event?.text ? (
                <p className="event-text">{e.event.text}</p>
              ) : null}
              <div className="event-tokens">
                <span>visual {e.tokens.visual}</span>
                <span>dense {e.tokens.baselineDense}</span>
                <span>generated {e.tokens.generated}</span>
                <span>saved {savedPct}%</span>
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}
