import { useCallback, useEffect, useRef, useState } from "react";
import type { StreamWindowEvent } from "@streaming-insights/shared";

/**
 * Live per-window event feed. Newest first: the `events` prop is kept in
 * stream order (oldest -> newest) by the App, so the list renders reversed and
 * the newest window sits at the top.
 *
 * Live updates while the user is at the top: a new window pushes the current
 * top row down into place with the scroll pinned, so the feed "updates in
 * place" without jumping. When the user scrolls away from the top to read
 * history, the scroll position is held steady — in-view events stay where they
 * are and new windows accumulate silently at the top. A "Jump to latest"
 * affordance returns to the live edge.
 */
export function EventFeed({ events }: { events: StreamWindowEvent[] }) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);

  // The newest window first.
  const ordered = [...events].reverse();

  // The user manually scrolled away from the live edge (top) -> hold position.
  const onScroll = useCallback(() => {
    const el = feedRef.current;
    if (el) setAutoFollow(el.scrollTop < 2);
  }, []);

  // Auto-follow: keep the live edge (top) pinned while new windows arrive.
  useEffect(() => {
    if (!autoFollow) return;
    const el = feedRef.current;
    if (el) el.scrollTop = 0;
  }, [autoFollow, events.length]);

  // Jump back to the live edge (also re-arms auto-follow).
  const jumpToLatest = useCallback(() => {
    const el = feedRef.current;
    if (el) el.scrollTop = 0;
    setAutoFollow(true);
  }, []);

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
    <div
      ref={feedRef}
      className={`feed${autoFollow ? "" : " is-anchored"}`}
      onScroll={onScroll}
      aria-live="polite"
    >
      {!autoFollow ? (
        <button
          type="button"
          className="feed-jump"
          onClick={jumpToLatest}
          aria-label="Jump to the latest events"
        >
          ↓ Jump to latest
        </button>
      ) : null}
      {ordered.map((e) => {
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
