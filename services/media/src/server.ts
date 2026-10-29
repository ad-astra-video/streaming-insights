// Media server for the Mage-VL streaming showcase.
//
// A separate Fastify service with its own public origin (mirroring the
// highlights.live control-plane/media-server split). It terminates WebRTC
// ingest (werift), decodes sampled frames, groups them into codec-segment
// WINDOWS, reserves a runner slot via the control server, dispatches each
// window to a Mage-VL runner, and POSTs the per-window gate/token/text events
// to the control server (token ledger + springboard events).
//
// Routes:
//   POST /sessions                { source?, prompt?, runnerId? } -> provision + reserve runner slot
//   POST /sessions/:sid/rtc/offer  { offer }  -> { pcId, answer, iceServers }
//   POST /sessions/:sid/rtc/ice/:pcId { candidate } -> { ok }
//   POST /sessions/:sid/prompt     { text } -> persist prompt
//   GET  /stream/:sid             WebSocket the browser streams frames over
//   POST /sessions/:sid/close     force close + release the runner slot
//   GET  /health
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import type { MediaConfig } from "./config.js";
import { WebRtcIngestSession } from "./rtc.js";
import { WindowAccumulator, type CodecWindow, type IngestFrame } from "./windows.js";
import {
  ControlClient,
  LocalControlClient,
  type EventPayload,
  type LedgerWindowPayload,
} from "./control-client.js";
import {
  HttpRunnerClient,
  MockRunnerClient,
  type MageRunnerClient,
  type WindowOutcome,
} from "./runner-client.js";
import type { FastifyInstance } from "fastify";

interface ActiveStream {
  sid: string;
  source: string;
  prompt?: string;
  windows: WindowAccumulator;
  rtc?: { pcId: string; session: WebRtcIngestSession };
  sockets: Set<any>;
  closed: boolean;
  runner: MageRunnerClient;
  windowsPosted: number;
  eventsPosted: number;
  /** Session-relative clock origin (epoch seconds of the first dispatched
   *  window). Windows report tStart/tEnd RELATIVE to this so the dashboard
   *  renders `12.3s–13.4s` instead of a raw epoch seconds value. */
  t0?: number;
}

export interface MediaServerDeps {
  cfg: MediaConfig;
  /** Control client; defaults to a ControlClient from cfg.controlBase or a
   *  LocalControlClient when no control server is configured (isolated demos). */
  control?: ControlClient | LocalControlClient;
  /** Mage-VL runner client; defaults to HttpRunnerClient(cfg.runnerBase) or
   *  MockRunnerClient. */
  runner?: MageRunnerClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MediaServer {
  private active = new Map<string, ActiveStream>();
  private graceTimers = new Map<string, NodeJS.Timeout>();
  private noClientTimers = new Map<string, NodeJS.Timeout>();
  private control: ControlClient | LocalControlClient;
  private runner: MageRunnerClient;
  private cfg: MediaConfig;
  /** Rate-limit gate for ffmpeg decode diagnostics. */
  private lastFfmpegWarnAt = 0;
  /** True when the ffmpeg binary the RTC decoder shells out to is present. */
  private ffmpegAvailable = false;

  constructor(deps: MediaServerDeps) {
    this.cfg = deps.cfg;
    this.control = deps.control ?? this.defaultControl();
    this.runner = deps.runner ?? this.defaultRunner();
  }

  private defaultControl(): ControlClient | LocalControlClient {
    if (this.cfg.controlBase) return new ControlClient(this.cfg.controlBase);
    return new LocalControlClient();
  }

  private defaultRunner(): MageRunnerClient {
    if (this.cfg.runnerBase && !this.cfg.mockRunner) return new HttpRunnerClient(this.cfg.runnerBase);
    return new MockRunnerClient({
      gateThreshold: this.cfg.gateThreshold,
      denseTokensPerFrame: this.cfg.denseTokensPerFrame,
      sparseTokensPerFrame: this.cfg.sparseTokensPerFrame,
      speakTokensPerWindow: this.cfg.speakTokensPerWindow,
    });
  }

  async build(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    // WebRTC ingest decodes through the ffmpeg binary. Probe it once at boot so
    // a packaging regression is loud instead of a silent `frames=0`.
    this.ffmpegAvailable = spawnSync(this.cfg.ffmpegBin ?? "ffmpeg", ["-version"], { encoding: "utf8" }).status === 0;
    if (!this.ffmpegAvailable) {
      // eslint-disable-next-line no-console
      console.error(
        "[media] ffmpeg binary not found on PATH — WebRTC ingest will decode 0 frames " +
          "(the WSS frame rail still works). Install ffmpeg in the image or set FFMPEG_BIN.",
      );
    }
    app.register(cors, { origin: true });
    await app.register(websocket, { options: { maxPayload: 4 * 1024 * 1024 } });

    // Provision an ingest session and reserve a runner slot.
    app.post<{ Body: { source?: string; prompt?: string; runnerId?: string } }>(
      "/sessions",
      async (req, reply) => {
        const source = req.body?.source ?? "webrtc";
        const prompt = req.body?.prompt;
        let reserved;
        try {
          reserved = await this.control.reserveStreamSession(source, { runnerId: req.body?.runnerId });
        } catch (e: any) {
          return reply.code(503).send({ error: String(e?.message || e) });
        }
        const sid = reserved.session.id;
        const win = new WindowAccumulator({ windowFrames: this.cfg.windowFrames });
        const stream: ActiveStream = {
          sid,
          source,
          prompt,
          windows: win,
          sockets: new Set(),
          closed: false,
          runner: this.runner,
          windowsPosted: 0,
          eventsPosted: 0,
        };
        win.on("window", (w) => void this.handleWindow(stream, w).catch((e) => console.error("[media] window err", e)));
        this.active.set(sid, stream);
        if (prompt) {
          void this.control.postPrompt(sid, prompt).catch(() => {});
        }
        const noClientMs = this.cfg.provisionNoClientMs;
        if (noClientMs !== undefined && noClientMs > 0) {
          this.noClientTimers.set(
            sid,
            setTimeout(() => {
              this.noClientTimers.delete(sid);
              void this.teardown(sid).catch(() => {});
            }, noClientMs)
          );
        }
        const publicBase = (this.cfg.publicBaseUrl || "").replace(/\/+$/, "");
        const wsBase = publicBase.replace(/^http/, "ws");
        return {
          sessionId: sid,
          streamSessionId: sid,
          source,
          wsPath: `/stream/${sid}`,
          wsUrl: wsBase ? `${wsBase}/stream/${sid}` : undefined,
          rtcOrigin: publicBase || undefined,
          rtc: true,
          iceServers: this.cfg.rtcIceServers,
          runner: reserved.runner,
          prompt: prompt ?? null,
        };
      }
    );

    // WebRTC ingest signaling: browser creates the offer, server answers as a
    // recvonly terminus; decoded frames feed the window accumulator, which
    // drives the Mage-VL runner and posts each window's event to the control.
    app.post<{ Params: { sid: string }; Body: { offer?: any } }>("/sessions/:sid/rtc/offer", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) return reply.code(404).send({ error: "no such session" });
      if (!req.body?.offer) return reply.code(400).send({ error: "offer required" });
      if (!stream.rtc) {
        const session = new WebRtcIngestSession({
          sampleFps: this.cfg.sampleFps,
          iceServers: this.cfg.rtcIceServers,
        });
        session.on("frame", (f: { seq: number; ts: number; jpeg: Buffer; latencyMs?: number }) => {
          this.addFrame(stream, f);
        });
        session.on("close", () => {
          if (stream.sockets.size === 0) this.armGrace(req.params.sid);
        });
        session.on("error", (e) => console.error("[media] rtc err", e));
        // Decode diagnostics: a missing/failing ffmpeg used to be invisible —
        // the session logged `packets>0 frames=0` and no window reached the
        // runner. Surface it loudly and rate-limit (one line per 5s).
        session.on("ffmpeg", (msg: string) => {
          const now = Date.now();
          if (now - this.lastFfmpegWarnAt > 5000) {
            this.lastFfmpegWarnAt = now;
            console.error("[media] ffmpeg decode:", msg);
          }
        });
        stream.rtc = { pcId: randomUUID(), session };
        this.clearNoClient(req.params.sid);
      }
      const { session } = stream.rtc;
      try {
        const answer = await session.handleOffer(req.body.offer);
        return { pcId: stream.rtc.pcId, answer, iceServers: this.cfg.rtcIceServers };
      } catch (e: any) {
        return reply.code(400).send({ error: String(e?.message || e) });
      }
    });

    app.post<{ Params: { sid: string; pcId: string }; Body: { candidate?: any } }>(
      "/sessions/:sid/rtc/ice/:pcId",
      async (req, reply) => {
        const stream = this.active.get(req.params.sid);
        if (!stream?.rtc || !req.body?.candidate) return reply.code(404).send({ error: "no rtc session" });
        await stream.rtc.session.addIceCandidate(req.body.candidate);
        return { ok: true };
      }
    );

    // Update the session prompt (persisted to the control server + used in the
    // next dispatched window).
    app.post<{ Params: { sid: string }; Body: { text: string } }>("/sessions/:sid/prompt", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) return reply.code(404).send({ error: "no such session" });
      const text = req.body?.text;
      if (typeof text !== "string" || text.length === 0) return reply.code(422).send({ error: "text is required" });
      stream.prompt = text;
      void this.control.postPrompt(req.params.sid, text).catch(() => {});
      return { ok: true };
    });

    // Browser streams sampled frames over this WS; each frame feeds the window
    // accumulator just like the WebRTC decode rail. (@fastify/websocket v11
    // hands the route a `ws` WebSocket, not the v8 SocketStream.)
    app.get<{ Params: { sid: string } }>("/stream/:sid", { websocket: true }, async (socket, req) => {
      const stream = this.active.get(req.params.sid);
      if (!stream || stream.closed) {
        socket.close(1008, "no such session");
        return;
      }
      stream.sockets.add(socket);
      this.clearGrace(req.params.sid);
      this.clearNoClient(req.params.sid);
      socket.on("message", (data: any) => {
        void this.handleWsFrame(stream, data).catch((e) => console.error("[media] frame err", e));
      });
      const onClose = () => {
        stream.sockets.delete(socket);
        if (stream.sockets.size === 0) this.armGrace(req.params.sid);
      };
      socket.on("close", onClose);
      socket.on("error", onClose);
    });

    // Control-plane close (e.g. user Stop in the UI).
    app.post<{ Params: { sid: string } }>("/sessions/:sid/close", async (req, reply) => {
      const stream = this.active.get(req.params.sid);
      if (!stream) return reply.code(404).send({ error: "no such session" });
      await this.teardown(req.params.sid);
      return { ok: true };
    });

    app.get("/health", async () => {
      const sessions = [...this.active.values()].map((s) => ({
        sid: s.sid,
        source: s.source,
        windowsPosted: s.windowsPosted,
        eventsPosted: s.eventsPosted,
        closed: s.closed,
      }));
      return { status: "ok", activeSessions: sessions, decode: { ffmpeg: this.ffmpegAvailable } };
    });

    // Alias for the deploy health probe (compose hits /api/health).
    app.get("/api/health", async () => {
      const sessions = [...this.active.values()].map((s) => ({
        sid: s.sid,
        source: s.source,
        windowsPosted: s.windowsPosted,
        eventsPosted: s.eventsPosted,
        closed: s.closed,
      }));
      return { status: "ok", activeSessions: sessions, decode: { ffmpeg: this.ffmpegAvailable } };
    });

    return app;
  }

  /** Route one decoded frame (RTC or WS) into the window accumulator. */
  private addFrame(stream: ActiveStream, frame: IngestFrame): void {
    stream.windows.addFrame(frame);
  }

  private async handleWsFrame(stream: ActiveStream, raw: any): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const { seq, image, timestamp } = msg ?? {};
    if (typeof seq !== "number" || typeof image !== "string" || !image) return;
    const jpeg = Buffer.from(image, "base64");
    if (!jpeg.length) return;
    const ts = typeof timestamp === "number" ? timestamp : Date.now() / 1000;
    this.addFrame(stream, { seq, ts, jpeg });
  }

  /** Dispatch one closed window to the runner and POST the outcome to the
   *  control server (token ledger + springboard event). */
  private async handleWindow(stream: ActiveStream, window: CodecWindow): Promise<void> {
    if (stream.closed) return;
    const outcome: WindowOutcome = await stream.runner.driveWindow(window, stream.prompt);
    // Session-relative window bounds (the webapp renders these as seconds since
    // the stream started; raw epoch seconds rendered as e.g. `1793311118.5s`).
    if (stream.t0 === undefined) stream.t0 = window.tStart;
    const tStart = Math.max(window.tStart - stream.t0, 0);
    const tEnd = Math.max(window.tEnd - stream.t0, tStart);
    // A silent window generates no response tokens by contract; the runner may
    // still report a speculative count, so normalize here instead of letting a
    // silent window show "generated N tokens".
    const generated = outcome.decision === "silent" ? 0 : outcome.tokensGenerated;
    // 1) token-ledger row.
    const ledger: LedgerWindowPayload = {
      seq: window.seq,
      tStart,
      tEnd,
      pSpeak: outcome.pSpeak,
      decision: outcome.decision,
      tokensVisual: outcome.tokensVisual,
      tokensBaselineDense: outcome.tokensBaselineDense,
      tokensGenerated: generated,
      prompt: stream.prompt,
      responseText: outcome.responseText ?? undefined,
    };
    // 2) springboard event (gate + tokens + text).
    const saved = Math.max(outcome.tokensBaselineDense - outcome.tokensVisual, 0);
    // CONTRACT: `savedVsBaseline` is a FRACTION (1 - visual/baselineDense), not
    // the saved token COUNT. Emitting the count made the webapp feed print
    // "saved 69000%".
    const savedVsBaseline =
      outcome.tokensBaselineDense > 0 ? Math.min(saved / outcome.tokensBaselineDense, 1) : 0;
    const event: EventPayload = {
      seq: window.seq,
      tStart,
      tEnd,
      gate: { pSpeak: outcome.pSpeak, decision: outcome.decision },
      tokens: {
        visual: outcome.tokensVisual,
        baselineDense: outcome.tokensBaselineDense,
        generated,
        savedVsBaseline,
      },
      prompt: stream.prompt,
      event: {
        type: outcome.decision === "speak" ? "response" : "silent",
        text: outcome.responseText,
      },
    };
    try {
      await this.control.postWindow(stream.sid, ledger);
      stream.windowsPosted++;
    } catch (e) {
      console.error("[media] postWindow failed", e);
    }
    try {
      await this.control.postEvent(stream.sid, event);
      stream.eventsPosted++;
    } catch (e) {
      console.error("[media] postEvent failed", e);
    }
    // Relay the window outcome to any live browser sockets (the webapp feed).
    const payload = JSON.stringify({ type: "window", window: event });
    for (const s of stream.sockets) {
      try {
        s.send(payload);
      } catch {
        /* skip */
      }
    }
  }

  private armGrace(sid: string): void {
    this.clearGrace(sid);
    const ms = this.cfg.reconnectGraceMs;
    if (ms === undefined || ms <= 0) {
      void this.teardown(sid).catch(() => {});
      return;
    }
    this.graceTimers.set(
      sid,
      setTimeout(() => {
        this.graceTimers.delete(sid);
        void this.teardown(sid).catch(() => {});
      }, ms)
    );
  }

  private clearGrace(sid: string): void {
    const t = this.graceTimers.get(sid);
    if (t) {
      clearTimeout(t);
      this.graceTimers.delete(sid);
    }
  }

  private clearNoClient(sid: string): void {
    const t = this.noClientTimers.get(sid);
    if (t) {
      clearTimeout(t);
      this.noClientTimers.delete(sid);
    }
  }

  /** Stop the ingest + release the reserved runner slot. Idempotent. */
  private async teardown(sid: string): Promise<void> {
    this.clearGrace(sid);
    this.clearNoClient(sid);
    const stream = this.active.get(sid);
    if (!stream || stream.closed) return;
    stream.closed = true;
    // Flush any buffered partial window so the last frames are not lost.
    stream.windows.flush();
    if (stream.rtc) {
      void stream.rtc.session.close().catch(() => {});
      stream.rtc = undefined;
    }
    for (const s of stream.sockets) {
      try {
        s.terminate();
      } catch {
        /* skip */
      }
    }
    try {
      await this.control.endStreamSession(sid);
    } catch (e) {
      console.error("[media] endStreamSession failed", e);
    }
    this.active.delete(sid);
  }
}
