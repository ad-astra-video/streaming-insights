/**
 * Browser ingest client: turns a local MediaStream into a real streaming
 * session on the media server.
 *
 * Two transports, chosen at runtime:
 *
 *  - `webrtc` — the preferred path. We provision a session, negotiate an
 *    offer/answer against `/sessions/:sid/rtc/offer` and send the video track
 *    over SRTP. This only works when the browser can reach an ICE candidate the
 *    media server gathers (a public host candidate, a forwarded UDP port, or a
 *    TURN relay). On a LAN/NAT-fronted box with no TURN the relay candidates
 *    are unreachable, so the negotiation stalls.
 *  - `ws` — fallback over the same public origin. We sample the stream onto a
 *    canvas at `sampleFps` and push JPEG frames to `/stream/:sid`, which feeds
 *    the identical window/dispatch pipeline on the server. This rides the
 *    HTTPS/WSS origin (Cloudflare tunnel) so it needs no inbound UDP.
 *
 * The server treats both transports identically from the window accumulator
 * onward, so telemetry/data-out is the same either way; the transport used is
 * reported through `onStatus` so the UI (and QA) can tell them apart.
 */
import type { StreamWindowEvent } from "@streaming-insights/shared";

export type IngestTransport = "webrtc" | "ws";
export type IngestStatus =
  | { state: "provisioning" }
  | { state: "negotiating" }
  | { state: "live"; transport: IngestTransport; sessionId: string }
  | { state: "error"; message: string };

export interface IngestSession {
  sessionId: string;
  transport: IngestTransport;
  /** Update the active prompt on the media server. */
  setPrompt(prompt: string | null): Promise<void>;
  /** Stop sending and release the server-side session + runner slot. */
  close(): Promise<void>;
}

export interface StartIngestOptions {
  stream: MediaStream;
  /** Media server public origin (e.g. https://mage-media.dpn.gg). */
  mediaBaseUrl: string;
  prompt?: string | null;
  /** Frames per second sampled for the `ws` transport. Default 2. */
  sampleFps?: number;
  /** How long to wait for ICE to connect before falling back to `ws`. */
  rtcConnectTimeoutMs?: number;
  onStatus?: (status: IngestStatus) => void;
}

export interface ProvisionResponse {
  sessionId?: string;
  streamSessionId?: string;
  wsUrl?: string;
  rtc?: boolean;
  iceServers?: { urls: string | string[]; username?: string; credential?: string }[];
  error?: string;
}

const DEFAULT_RTC_CONNECT_TIMEOUT_MS = 6000;

function normalizeBase(base: string): string {
  return base.trim().replace(/\/+$/, "");
}

async function provision(
  mediaBaseUrl: string,
  prompt: string | null
): Promise<{ sid: string; body: ProvisionResponse }> {
  const res = await fetch(`${normalizeBase(mediaBaseUrl)}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source: "webrtc", prompt: prompt ?? undefined }),
  });
  const body = (await res.json().catch(() => ({}))) as ProvisionResponse;
  const sid = body.sessionId ?? body.streamSessionId;
  if (!res.ok || !sid) {
    throw new Error(body.error || `media session provision failed (${res.status})`);
  }
  return { sid, body };
}

/** Negotiate the WebRTC send-only rail. Resolves once ICE connects, rejects on
 *  timeout/negotiation failure so the caller can fall back to `ws`. */
async function negotiateRtc(
  mediaBaseUrl: string,
  sid: string,
  stream: MediaStream,
  iceServers: ProvisionResponse["iceServers"],
  timeoutMs: number
): Promise<RTCPeerConnection> {
  const pc = new RTCPeerConnection({
    ...(iceServers?.length ? { iceServers } : {}),
  });
  for (const track of stream.getVideoTracks()) pc.addTrack(track, stream);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const res = await fetch(`${normalizeBase(mediaBaseUrl)}/sessions/${sid}/rtc/offer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offer: { type: offer.type, sdp: offer.sdp } }),
  });
  const body = (await res.json().catch(() => ({}))) as { answer?: RTCSessionDescriptionInit; error?: string };
  if (!res.ok || !body.answer) {
    pc.close();
    throw new Error(body.error || `rtc offer rejected (${res.status})`);
  }
  await pc.setRemoteDescription(body.answer);

  await new Promise<void>((resolve, reject) => {
    if (pc.connectionState === "connected") return resolve();
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`rtc ice did not connect within ${timeoutMs}ms`));
    }, timeoutMs);
    const onState = () => {
      if (pc.connectionState === "connected") {
        cleanup();
        resolve();
      } else if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        cleanup();
        reject(new Error(`rtc connection ${pc.connectionState}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timer);
      pc.removeEventListener("connectionstatechange", onState);
    };
    pc.addEventListener("connectionstatechange", onState);
  }).catch((e) => {
    pc.close();
    throw e;
  });

  return pc;
}

/** Sample a video element onto a canvas and push JPEG frames over the ws rail. */
function startWsIngest(
  scriptUrl: string,
  video: HTMLVideoElement,
  sampleFps: number
): { stop: () => void } {
  const ws = new WebSocket(scriptUrl);
  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth || 640;
  canvas.height = video.videoHeight || 360;
  const ctx = canvas.getContext("2d");
  let seq = 0;
  let timer: number | null = null;

  const pump = () => {
    if (!ctx || ws.readyState !== WebSocket.OPEN) return;
    if (video.readyState < 2) return;
    canvas.width = video.videoWidth || canvas.width;
    canvas.height = video.videoHeight || canvas.height;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.6);
    const image = dataUrl.slice(dataUrl.indexOf(",") + 1);
    ws.send(
      JSON.stringify({
        seq: seq++,
        image,
        // Wall-clock seconds: the media server uses this for the window's
        // tStart/tEnd and the control-plane event ledger, so page-relative
        // `performance.now()` produced nonsensical (near-zero) timestamps.
        timestamp: Date.now() / 1000,
      })
    );
  };

  timer = window.setInterval(pump, Math.max(50, Math.round(1000 / Math.max(0.5, sampleFps))));

  return {
    stop: () => {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      try {
        ws.close();
      } catch {
        // already closed
      }
    },
  };
}

/**
 * Provision a session and start streaming `stream` to the media server.
 * Prefers WebRTC; falls back to the WSS frame rail when ICE cannot connect.
 * Throws only if both transports fail.
 */
export async function startIngest(opts: StartIngestOptions): Promise<IngestSession> {
  const mediaBaseUrl = normalizeBase(opts.mediaBaseUrl);
  const prompt = opts.prompt ?? null;
  const onStatus = opts.onStatus;

  onStatus?.({ state: "provisioning" });
  const { sid, body } = await provision(mediaBaseUrl, prompt);

  let pc: RTCPeerConnection | null = null;
  let wsIngest: { stop: () => void } | null = null;
  let transport: IngestTransport | null = null;
  const failures: string[] = [];

  if (body.rtc !== false) {
    onStatus?.({ state: "negotiating" });
    try {
      pc = await negotiateRtc(
        mediaBaseUrl,
        sid,
        opts.stream,
        body.iceServers,
        opts.rtcConnectTimeoutMs ?? DEFAULT_RTC_CONNECT_TIMEOUT_MS
      );
      transport = "webrtc";
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
      pc = null;
    }
  }

  if (!transport) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = opts.stream;
    await video.play().catch(() => {});
    const wsUrl =
      body.wsUrl ?? `${mediaBaseUrl.replace(/^http/, "ws")}/stream/${sid}`;
    try {
      wsIngest = startWsIngest(wsUrl, video, opts.sampleFps ?? 2);
      transport = "ws";
    } catch (e) {
      failures.push(e instanceof Error ? e.message : String(e));
    }
  }

  if (!transport) {
    await closeSession(mediaBaseUrl, sid);
    const message = `ingest failed: ${failures.join("; ")}`;
    onStatus?.({ state: "error", message });
    throw new Error(message);
  }

  onStatus?.({ state: "live", transport, sessionId: sid });

  let closed = false;
  return {
    sessionId: sid,
    transport,
    async setPrompt(next: string | null) {
      if (closed) return;
      await fetch(`${mediaBaseUrl}/sessions/${sid}/prompt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: next }),
      }).catch(() => {});
    },
    async close() {
      if (closed) return;
      closed = true;
      wsIngest?.stop();
      pc?.close();
      await closeSession(mediaBaseUrl, sid);
    },
  };
}

async function closeSession(mediaBaseUrl: string, sid: string): Promise<void> {
  await fetch(`${normalizeBase(mediaBaseUrl)}/sessions/${sid}/close`, {
    method: "POST",
  }).catch(() => {});
}

/** Control-plane SSE feed URL for a session; exported for tests/UI reuse. */
export function springboardUrl(controlBaseUrl: string, sessionId: string): string {
  return `${normalizeBase(controlBaseUrl)}/api/sessions/${encodeURIComponent(sessionId)}/events`;
}

export type { StreamWindowEvent };
