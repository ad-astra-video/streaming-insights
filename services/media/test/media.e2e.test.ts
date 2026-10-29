import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useH264 } from "werift";
import { MediaServer } from "../src/server";
import type { CodecWindow } from "../src/windows";
import type { MageRunnerClient, WindowOutcome } from "../src/runner-client";
import type { MediaConfig } from "../src/config";
// Boot the real control server in-process (PGlite) so the media server's
// runner-slot reservation + window/event posting exercise the actual API.
import { buildApp } from "../../server/src/app";
import { openPgliteDb } from "../../server/src/db";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { ServerConfig } from "../../server/src/config";

const SERVER_MIGRATIONS_DIR = path.resolve(import.meta.dirname, "../../server/drizzle");

/** Deterministic runner so the E2E reliably produces BOTH a silent (gate
 *  savings) and a speak (text) window. */
class FakeRunner implements MageRunnerClient {
  calls: CodecWindow[] = [];
  async driveWindow(window: CodecWindow, prompt?: string): Promise<WindowOutcome> {
    this.calls.push(window);
    const speak = window.seq % 2 === 1;
    return {
      pSpeak: speak ? 0.81 : 0.18,
      decision: speak ? "speak" : "silent",
      tokensVisual: window.frames.length * 129,
      tokensBaselineDense: window.frames.length * 576,
      tokensGenerated: speak ? 48 : 0,
      responseText: speak ? `The stream changed (window ${window.seq}).` : null,
    };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("media server E2E ingest -> window -> runner dispatch -> control", () => {
  let ctrl: FastifyInstance;
  let ctrlBase: string;
  let media: FastifyInstance;
  let mediaBase: string;
  let runnerId: string;
  const fake = new FakeRunner();

  beforeAll(async () => {
    // Control server (in-process, PGlite).
    const ctrlCfg: ServerConfig = {
      port: 0,
      nodeEnv: "test",
      runners: 3,
      streamsPerRunner: 3,
      maxStreams: 9,
      runnerHeartbeatTtlMs: 15000,
    };
    const { db } = await openPgliteDb();
    await migrate(db, { migrationsFolder: SERVER_MIGRATIONS_DIR });
    ctrl = buildApp({ db, cfg: ctrlCfg });
    await ctrl.listen({ port: 0, host: "127.0.0.1" });
    ctrlBase = `http://127.0.0.1:${(ctrl.server.address() as any).port}`;

    // Register a runner so /stream-sessions has capacity to reserve against.
    const rr = await ctrl.inject({
      method: "POST",
      url: "/runners",
      payload: { name: "runner-0", gpuIndex: 0, host: "box-151" },
    });
    runnerId = rr.json().id;

    // Media server pointed at the real control server, high sample cadence so
    // a fast RTC test still closes several windows.
    const mediaCfg: MediaConfig = {
      port: 0,
      nodeEnv: "test",
      controlBase: ctrlBase,
      mockRunner: false,
      sampleFps: 10,
      windowFrames: 2,
      gateThreshold: 0.5,
      denseTokensPerFrame: 576,
      sparseTokensPerFrame: 129,
      speakTokensPerWindow: 48,
      runnerHeartbeatTtlMs: 15000,
      reconnectGraceMs: 300,
      provisionNoClientMs: 5000,
    };
    const ms = new MediaServer({ cfg: mediaCfg, runner: fake });
    media = await ms.build();
    await media.listen({ port: 0, host: "127.0.0.1" });
    mediaBase = `http://127.0.0.1:${(media.server.address() as any).port}`;
  });

  afterAll(async () => {
    await media.close();
    await ctrl.close();
  });

  function nalUnits(data: Buffer): Buffer[] {
    const out: Buffer[] = [];
    let i = 0;
    while (i < data.length - 3) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        let s = i + 3;
        if (data[s] === 0 && data[s + 1] === 1) s += 1;
        let e = s;
        while (e < data.length && !(data[e] === 0 && data[e + 1] === 0 && (data[e + 2] === 1 || data[e + 2] === 0))) e++;
        if (e > s) out.push(data.subarray(s, e));
        i = e;
      } else i++;
    }
    return out;
  }

  async function poll<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 15000): Promise<T> {
    const start = Date.now();
    let v = await fn();
    while (!pred(v) && Date.now() - start < ms) {
      await sleep(150);
      v = await fn();
    }
    return v;
  }

  it("streams a clip over RTC -> per-window events (gate + tokens + text) + runner slot usage", async () => {
    // 1) provision a media session -> reserves a runner slot on the control.
    const prov = await media.inject({ method: "POST", url: "/sessions", payload: { source: "webrtc" } });
    expect(prov.statusCode).toBe(200);
    const provBody = prov.json();
    const sid = provBody.sessionId;
    expect(provBody.rtc).toBe(true);
    // dispatches a runner that reports slot usage
    expect(provBody.runner.slotsUsed).toBe(1);

    // 2) generate a small real H264 clip and stream it over RTP.
    const h264Path = path.join(tmpdir(), `si-e2e-${process.pid}.h264`);
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
      "-t", "0.8", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "h264", h264Path,
    ]);
    const h264 = readFileSync(h264Path);

    const browserPc = new RTCPeerConnection({ codecs: { video: [useH264()] } } as any);
    const sendTrack = new MediaStreamTrack({ kind: "video" });
    browserPc.addTransceiver(sendTrack, { direction: "sendonly" } as any);
    const offer = await browserPc.createOffer();
    await browserPc.setLocalDescription(offer);
    const ans = await media.inject({ method: "POST", url: `/sessions/${sid}/rtc/offer`, payload: { offer } });
    expect(ans.statusCode).toBe(200);
    const { answer } = ans.json();
    await browserPc.setRemoteDescription(answer);
    for (let i = 0; i < 40 && browserPc.connectionState !== "connected"; i++) await sleep(50);
    expect(browserPc.connectionState).toBe("connected");

    const sender = browserPc.getTransceivers().find((t) => t.sender)?.sender;
    const s = sender as any;
    if (s) {
      s.sequenceNumber = 0;
      s.timestamp = 0;
      s.seqOffset = 0;
      s.timestampOffset = 0;
    }
    const pay = s?.codec?.payloadType ?? 96;
    const nals = nalUnits(h264);
    // Space frames so the media server's cadence sampler closes several windows.
    let clock = 0, ts = 0;
    for (const nal of nals) {
      sendTrack.writeRtp(
        new RtpPacket(new RtpHeader({
          payloadType: pay,
          sequenceNumber: (clock++) % 65536,
          timestamp: (ts += 90000 / 15),
          ssrc: s?.ssrc ?? 1,
          marker: 1,
        } as any), nal)
      );
      await sleep(150);
    }
    await browserPc.close();
    await sleep(800); // let in-flight ffmpeg samples + window dispatch settle

    // 3) per-window events produced on the control server (token ledger + events).
    const windows = await poll(
      async () => (await ctrl.inject({ method: "GET", url: `/stream-sessions/${sid}/windows` })).json(),
      (b: any) => b.windows.length >= 2
    );
    expect(windows.windows.length).toBeGreaterThanOrEqual(2);
    // gate (pSpeak + decision) and tokens present per window
    for (const w of windows.windows) {
      expect(typeof w.pSpeak).toBe("number");
      expect(["silent", "speak"]).toContain(w.decision);
      expect(typeof w.tokensVisual).toBe("number");
      expect(typeof w.tokensBaselineDense).toBe("number");
    }

    const events = await poll(
      async () => (await ctrl.inject({ method: "GET", url: `/stream-sessions/${sid}/events` })).json(),
      (b: any) => b.events.length >= 2
    );
    const evs = events.events as any[];
    expect(evs.length).toBeGreaterThanOrEqual(2);
    // at least one speak window carries text (gate + tokens + text contract)
    const withText = evs.filter((e) => e.event?.text);
    expect(withText.length).toBeGreaterThanOrEqual(1);
    for (const e of evs) {
      expect(e.gate).toMatchObject({ pSpeak: expect.any(Number) });
      expect(["silent", "speak"]).toContain(e.gate.decision);
      expect(typeof e.tokens.visual).toBe("number");
      expect(typeof e.tokens.baselineDense).toBe("number");
      expect(typeof e.tokens.generated).toBe("number");
      expect(typeof e.tokens.savedVsBaseline).toBe("number");
    }

    // fake runner was actually dispatched for each window
    expect(fake.calls.length).toBeGreaterThanOrEqual(2);

    // 4) runner reports slot usage: reservation recorded on the control runner.
    const runners = (await ctrl.inject({ method: "GET", url: "/runners" })).json();
    expect(runners.runners.some((r: any) => r.id === runnerId && r.slotsUsed === 1)).toBe(true);

    // 5) close -> reset the slot; the runner reports usage back to 0.
    const close = await media.inject({ method: "POST", url: `/sessions/${sid}/close` });
    expect(close.statusCode).toBe(200);
    const runnersAfter = await poll(
      async () => (await ctrl.inject({ method: "GET", url: "/runners" })).json(),
      (b: any) => b.runners.find((r: any) => r.id === runnerId)?.slotsUsed === 0
    );
    expect(runnersAfter.runners.find((r: any) => r.id === runnerId).slotsUsed).toBe(0);
  });
});
