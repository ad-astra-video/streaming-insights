import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { RTCPeerConnection, MediaStreamTrack, RtpHeader, RtpPacket, useVP8 } from "werift";
import { MediaServer } from "../src/server";
import type { MediaConfig } from "../src/config";

/**
 * VP8 RTC decode + ICE diagnostics (ADAAAA-7582).
 *
 * The deployed browser rail negotiates VP8 (Chrome's default), and the media
 * server had no coverage for that codec: the existing E2E streams H264 only.
 * Two failure modes it protects against:
 *
 *  1. `packets>0 frames=0` — the ffmpeg IVF decode path silently produced
 *     nothing, so no window ever reached the runner.
 *  2. the media process dying with an uncaught `EPIPE` when ffmpeg exits before
 *     consuming the segment (killed every live session at once).
 */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One-frame IVF records (32-byte "DKIF" header + records) from libvpx. */
function ivfFrames(buf: Buffer): Buffer[] {
  const frames: Buffer[] = [];
  let off = 0;
  const headerLen = buf.readUInt16LE(6);
  off = headerLen;
  while (off + 12 <= buf.length) {
    const size = buf.readUInt32LE(off);
    off += 12;
    frames.push(buf.subarray(off, off + size));
    off += size;
  }
  return frames;
}

describe("media server RTC VP8 decode", () => {
  let media: FastifyInstance;
  let mediaBase: string;

  beforeAll(async () => {
    const cfg: MediaConfig = {
      port: 0,
      nodeEnv: "test",
      controlBase: "", // local in-memory control (no slot reservation needed)
      mockRunner: true,
      sampleFps: 10,
      windowFrames: 2,
      gateThreshold: 0.5,
      denseTokensPerFrame: 576,
      sparseTokensPerFrame: 129,
      speakTokensPerWindow: 48,
      runnerHeartbeatTtlMs: 15000,
    };
    media = await new MediaServer({ cfg }).build();
    await media.listen({ port: 0, host: "127.0.0.1" });
    mediaBase = `http://127.0.0.1:${(media.server.address() as any).port}`;
  });

  afterAll(async () => {
    await media.close();
  });

  async function health() {
    const res = await fetch(`${mediaBase}/health`);
    return res.json() as Promise<any>;
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

  /** Send `frames` as VP8 RTP (one packet per frame, S=1 marker set). */
  async function streamVp8(sid: string, frames: Buffer[], fps = 15) {
    const browserPc = new RTCPeerConnection({ codecs: { video: [useVP8()] } } as any);
    const sendTrack = new MediaStreamTrack({ kind: "video" });
    browserPc.addTransceiver(sendTrack, { direction: "sendonly" } as any);
    const offer = await browserPc.createOffer();
    await browserPc.setLocalDescription(offer);
    const ans = await media.inject({ method: "POST", url: `/sessions/${sid}/rtc/offer`, payload: { offer } });
    expect(ans.statusCode).toBe(200);
    const { answer } = ans.json();
    // The answer must carry at least one candidate; a host-only (container
    // private) answer cannot reach a browser.
    const answerCands = (answer.sdp as string).split(/\r?\n/).filter((l) => l.startsWith("a=candidate:"));
    expect(answerCands.length).toBeGreaterThan(0);
    await browserPc.setRemoteDescription(answer);
    for (let i = 0; i < 60 && browserPc.connectionState !== "connected"; i++) await sleep(50);
    expect(browserPc.connectionState).toBe("connected");

    const sender = browserPc.getTransceivers().find((t) => t.sender)?.sender as any;
    if (sender) {
      sender.sequenceNumber = 0;
      sender.timestamp = 0;
      sender.seqOffset = 0;
      sender.timestampOffset = 0;
    }
    const pay = sender?.codec?.payloadType ?? 96;
    let seq = 0;
    let ts = 0;
    for (const frame of frames) {
      // RFC 7741 payload descriptor: S=1, PID=0, no extensions -> 0x10.
      const payload = Buffer.concat([Buffer.from([0x10]), frame]);
      sendTrack.writeRtp(
        new RtpPacket(
          new RtpHeader({
            payloadType: pay,
            sequenceNumber: seq++ % 65536,
            timestamp: (ts += 90000 / fps),
            ssrc: sender?.ssrc ?? 1,
            marker: 1,
          } as any),
          payload
        )
      );
      await sleep(120);
    }
    await sleep(600);
    await browserPc.close();
  }

  it("decodes VP8 into frames and closes windows", async () => {
    const prov = await media.inject({ method: "POST", url: "/sessions", payload: { source: "webrtc" } });
    expect(prov.statusCode).toBe(200);
    const sid = prov.json().sessionId;

    const ivfPath = path.join(tmpdir(), `si-vp8-${process.pid}.ivf`);
    execFileSync("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
      "-t", "1.2", "-c:v", "libvpx", "-b:v", "400k", "-f", "ivf", ivfPath,
    ]);
    const frames = ivfFrames(readFileSync(ivfPath));
    expect(frames.length).toBeGreaterThan(4);

    await streamVp8(sid, frames);

    const h = await poll(health, (b: any) => {
      const s = b.activeSessions.find((x: any) => x.sid === sid);
      return !!s && s.windowsPosted >= 2;
    });
    const session = h.activeSessions.find((x: any) => x.sid === sid);
    expect(session).toBeTruthy();
    // The frame decode path actually produced JPEGs...
    expect(session.rtc.framesEmitted).toBeGreaterThan(0);
    expect(session.rtc.packetsReceived).toBeGreaterThan(0);
    expect(session.rtc.codecMime).toMatch(/VP8/i);
    // ICE diagnostics track the peer lifecycle (a stale "new"/"checking" here
    // hid the fact that the answer was unreachable).
    expect(session.rtc.iceState).toBe("connected");
    // ...and those frames closed at least two dispatch windows.
    expect(session.windowsPosted).toBeGreaterThanOrEqual(2);

    await media.inject({ method: "POST", url: `/sessions/${sid}/close` });
  });

  it("survives undecodable frames (ffmpeg exits early -> EPIPE) and keeps serving", async () => {
    const prov = await media.inject({ method: "POST", url: "/sessions", payload: { source: "webrtc" } });
    const sid = prov.json().sessionId;

    // Garbage "VP8" payloads: ffmpeg rejects the stream and exits before
    // consuming stdin. Before the fix the stdin write raised an uncaught EPIPE
    // and the whole media process exited.
    const junk = Buffer.alloc(2048, 0x50);
    await streamVp8(sid, [junk, junk, junk]);

    const after = await poll(health, (b: any) => b.status === "ok", 4000);
    expect(after.status).toBe("ok");
    const session = after.activeSessions.find((x: any) => x.sid === sid);
    // Packets arrived; decoding them failed (frames stay 0) but the process lives.
    if (session?.rtc) {
      expect(session.rtc.packetsReceived).toBeGreaterThan(0);
      expect(session.rtc.framesEmitted).toBe(0);
    }
    await media.inject({ method: "POST", url: `/sessions/${sid}/close` });
    const final = await health();
    expect(final.status).toBe("ok");
  });
});
