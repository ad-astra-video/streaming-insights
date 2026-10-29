import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StreamWindowEvent } from "@streaming-insights/shared";
import { SourcePicker, type SourceKind } from "./components/SourcePicker";
import { Preview } from "./components/Preview";
import { PromptInput } from "./components/PromptInput";
import { EventFeed } from "./components/EventFeed";
import { TokenSavingsCard } from "./components/TokenSavingsCard";
import { StatusBadge, type SessionStatus } from "./components/StatusBadge";
import { SimFeed, SIM_EMIT_MS } from "./sim/simSource";
import { openLiveFeed } from "./lib/springboard";
import { accumulateMetrics } from "./lib/metrics";
import { startSimCanvas } from "./lib/canvas";

const DEMO_SESSION_ID = "demo-session";

export function App() {
  const [source, setSource] = useState<SourceKind | null>(null);
  const [status, setStatus] = useState<SessionStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [activePrompt, setActivePrompt] = useState<string | null>(null);
  const [events, setEvents] = useState<StreamWindowEvent[]>([]);
  const [sessionId, setSessionId] = useState<string>(
    () => new URLSearchParams(window.location.search).get("session") ?? ""
  );

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const simTimerRef = useRef<number | null>(null);
  const canvasCleanupRef = useRef<(() => void) | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const closeFeedRef = useRef<(() => void) | null>(null);
  const simFeedRef = useRef<SimFeed | null>(null);
  const activePromptRef = useRef<string | null>(null);
  const sessionIdRef = useRef(sessionId);

  activePromptRef.current = activePrompt;
  sessionIdRef.current = sessionId;

  const metrics = useMemo(() => accumulateMetrics(events), [events]);

  const addEvent = useCallback((e: StreamWindowEvent) => {
    setEvents((prev) => {
      if (prev.some((p) => p.seq === e.seq)) return prev;
      return [...prev.slice(-499), e];
    });
  }, []);

  const stopAll = useCallback(() => {
    if (simTimerRef.current) {
      window.clearInterval(simTimerRef.current);
      simTimerRef.current = null;
    }
    if (canvasCleanupRef.current) {
      canvasCleanupRef.current();
      canvasCleanupRef.current = null;
    }
    if (closeFeedRef.current) {
      closeFeedRef.current();
      closeFeedRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop());
      mediaStreamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => stopAll, [stopAll]);

  const startSource = useCallback(
    async (kind: SourceKind) => {
      stopAll();
      setError(null);
      setEvents([]);
      setSource(kind);
      setStatus("starting");

      if (kind === "sim") {
        simFeedRef.current = new SimFeed({ sessionId: DEMO_SESSION_ID });
        if (canvasRef.current) {
          canvasCleanupRef.current = startSimCanvas(canvasRef.current);
        }
        simTimerRef.current = window.setInterval(() => {
          const ev = simFeedRef.current?.next(
            activePromptRef.current ?? undefined
          );
          if (ev) addEvent(ev);
        }, SIM_EMIT_MS);
        setStatus("live");
        return;
      }

      // camera / screen: acquire a real media stream for the local preview.
      try {
        const stream =
          kind === "camera"
            ? await navigator.mediaDevices.getUserMedia({ video: true })
            : await navigator.mediaDevices.getDisplayMedia({ video: true });
        mediaStreamRef.current = stream;
        const v = videoRef.current;
        if (v) {
          v.srcObject = stream;
          await v.play().catch(() => {});
        }
        setStatus("live");

        // If a live session id is set, attach the real springboard SSE feed so
        // the webapp is a genuine consumer of the control-plane event stream.
        if (sessionIdRef.current) {
          closeFeedRef.current = openLiveFeed({
            sessionId: sessionIdRef.current,
            onEvent: addEvent,
            onStatus: (s) => {
              if (s === "error") setStatus("error");
            },
          });
        }
      } catch (e) {
        setStatus("error");
        setError(
          e instanceof Error ? e.message : "Could not start the selected source."
        );
      }
    },
    [addEvent, stopAll]
  );

  const handleStop = useCallback(() => {
    stopAll();
    setSource(null);
    setStatus("ended");
  }, [stopAll]);

  const handlePromptSubmit = useCallback(() => {
    const trimmed = prompt.trim();
    if (!trimmed) return;
    setActivePrompt(trimmed);
    // For a real session we would also PATCH the prompt to the control server;
    // that endpoint is provisioned by the pipeline phases, not this MVP screen.
  }, [prompt]);

  const isLive = status === "live";

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <h1 className="app-title">Streaming Insights</h1>
          <p className="app-subtitle">
            Mage-VL proactive-streaming · pick a source, set a prompt, watch
            token savings stream in.
          </p>
        </div>
        <StatusBadge status={status} />
      </header>

      {error ? (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button className="btn" type="button" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {/* Source picker */}
      <section aria-label="Source">
        <div className="source-row">
          <SourcePicker value={source} onChange={startSource} />
          {source ? (
            <button className="btn" type="button" onClick={handleStop}>
              Stop
            </button>
          ) : null}
        </div>
      </section>

      {/* Preview */}
      <Preview
        label={source === "sim" ? "Simulated feed" : source ?? undefined}
        emptyText="Choose a source to start the live preview."
      >
        {source === "sim" ? (
          <canvas ref={canvasRef} width={640} height={360} />
        ) : source === "camera" || source === "screen" ? (
          <video ref={videoRef} autoPlay muted playsInline />
        ) : null}
      </Preview>

      {/* Prompt */}
      <section aria-label="Prompt">
        <PromptInput
          value={prompt}
          onChange={setPrompt}
          onSubmit={handlePromptSubmit}
          activePrompt={activePrompt}
          disabled={status === "starting"}
        />
      </section>

      {/* Results: token savings + live event feed */}
      <div className="results">
        <section className="panel" aria-label="Token savings">
          <h2 className="panel-title">Token savings</h2>
          <TokenSavingsCard metrics={metrics} />
        </section>
        <section className="panel" aria-label="Live event feed">
          <h2 className="panel-title">Live event feed</h2>
          {!isLive && events.length === 0 ? (
            <div className="state-block">
              <p className="state-title">Waiting to start</p>
              <p className="state-body">
                Pick a source above to begin streaming. The Demo source is a
                self-contained simulated feed; Camera and Screen show your real
                preview and consume a connected live session.
              </p>
            </div>
          ) : (
            <EventFeed events={events} />
          )}
        </section>
      </div>

      {/* Secondary: live session / springboard connection */}
      <section className="panel" aria-label="Live session">
        <h2 className="panel-title">Live session (springboard)</h2>
        <div className="source-row">
          <input
            className="prompt-input grow"
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="Optional: paste a session id to consume its real event feed"
            aria-label="Session id"
          />
          <button
            className="btn"
            type="button"
            disabled={!sessionId.trim() || source === "sim"}
            onClick={() => setSource((s) => (s ? s : "screen"))}
          >
            Connect
          </button>
        </div>
        <p className="prompt-current">
          The webapp also consumes the structured data-out feed:{" "}
          <code>/api/sessions/&lt;id&gt;/events</code> (SSE).
        </p>
      </section>
    </div>
  );
}
