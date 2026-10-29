import type { StreamWindowEvent } from "@streaming-insights/shared";

export type LiveFeedStatus = "connecting" | "live" | "error";

export interface OpenLiveFeedOptions {
  sessionId: string;
  onEvent: (e: StreamWindowEvent) => void;
  onStatus?: (s: LiveFeedStatus) => void;
  /** Base URL for the control server; defaults to same-origin (dev proxy). */
  baseUrl?: string;
}

/**
 * Consume the control server's live SSE feed
 * (`GET /api/sessions/:id/events`) for a session. Returns a close() function.
 * The browser `EventSource` auto-reconnects on transient errors; we only
 * signal `error` when the connection is permanently closed.
 */
export function openLiveFeed(opts: OpenLiveFeedOptions): () => void {
  const base = opts.baseUrl ?? "";
  const url = `${base}/api/sessions/${encodeURIComponent(opts.sessionId)}/events`;
  const es = new EventSource(url);
  opts.onStatus?.("connecting");

  const handler = (ev: Event) => {
    const msg = ev as MessageEvent<string>;
    try {
      const data = JSON.parse(msg.data) as StreamWindowEvent;
      opts.onEvent(data);
      opts.onStatus?.("live");
    } catch {
      // ignore malformed frames
    }
  };
  es.addEventListener("window", handler);

  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      opts.onStatus?.("error");
    }
  };

  return () => es.close();
}
