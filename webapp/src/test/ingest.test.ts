import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit coverage for the browser ingest client: transport selection (WebRTC ->
 * WSS fallback), session provisioning, prompt push and teardown. The DOM/WebRTC
 * globals are stubbed because the webapp test environment is `node`.
 */

type FetchCall = { url: string; method: string; body: any };
let calls: FetchCall[] = [];

function jsonResponse(body: any, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const mediaStream = {
  getVideoTracks: () => [{}],
} as unknown as MediaStream;

class FakePc {
  static mode: "connect" | "stall" = "connect";
  /** ICE candidates the fake browser "gathers" during setLocalDescription, and
   *  one late candidate emitted after the remote description is applied. */
  static gathered: string[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  closed = false;
  private listeners = new Map<string, Set<(e: any) => void>>();
  constructor(public args: any) {}
  addTrack() {}
  addEventListener(ev: string, fn: (e: any) => void) {
    if (!this.listeners.has(ev)) this.listeners.set(ev, new Set());
    this.listeners.get(ev)!.add(fn);
  }
  removeEventListener(ev: string, fn: (e: any) => void) {
    this.listeners.get(ev)?.delete(fn);
  }
  private emit(ev: string, event: any) {
    for (const fn of this.listeners.get(ev) ?? []) fn(event);
  }
  private candidateEvent(candidate: string | null) {
    return {
      candidate: candidate === null ? null : { candidate, sdpMid: "0", sdpMLineIndex: 0 },
    };
  }
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {
    for (const c of FakePc.gathered) this.emit("icecandidate", this.candidateEvent(c));
  }
  localDescription = { type: "offer", sdp: "v=0" };
  async setRemoteDescription() {
    if (FakePc.mode === "connect") {
      this.connectionState = "connected";
      // A candidate that arrives after the answer: it must be posted directly,
      // not buffered forever.
      this.emit("icecandidate", this.candidateEvent("candidate:9 1 udp 1 136.33.135.223 49175 typ relay"));
      setTimeout(() => this.emit("connectionstatechange", {}), 0);
    }
  }
  close() {
    this.closed = true;
    this.connectionState = "closed";
  }
}

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = 1;
  sent: any[] = [];
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(payload: string) {
    this.sent.push(JSON.parse(payload));
  }
  close() {
    this.readyState = 3;
  }
}

const canvasContext = {
  drawImage: vi.fn(),
};
const fakeVideo = { videoWidth: 640, videoHeight: 360, readyState: 4, play: async () => {} };

describe("startIngest", () => {
  beforeEach(() => {
    calls = [];
    FakePc.mode = "connect";
    FakePc.gathered = [];
    FakeWebSocket.instances = [];
    (globalThis as any).RTCPeerConnection = FakePc;
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).document = {
      createElement: (tag: string) => {
        if (tag === "canvas") {
          return {
            width: 0,
            height: 0,
            getContext: () => canvasContext,
            toDataURL: () => "data:image/jpeg;base64,ZmFrZQ==",
          };
        }
        return fakeVideo;
      },
    };
    (globalThis as any).performance = { now: () => 1000 };
    (globalThis as any).window = {
      setInterval: (fn: () => void) => setTimeout(fn, 0) as unknown as number,
      clearInterval: () => {},
    };
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (String(url).endsWith("/sessions")) {
        return jsonResponse({
          sessionId: "sid-1",
          wsUrl: "wss://mage-media.example/stream/sid-1",
          rtc: true,
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
      }
      if (String(url).includes("/rtc/offer")) {
        return jsonResponse({ pcId: "pc-1", answer: { type: "answer", sdp: "v=0" } });
      }
      return jsonResponse({ ok: true });
    }) as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("negotiates WebRTC when ICE connects", async () => {
    const { startIngest } = await import("../lib/ingest");
    const statuses: string[] = [];
    const session = await startIngest({
      stream: mediaStream,
      mediaBaseUrl: "https://mage-media.example/",
      onStatus: (s: { state: string }) => statuses.push(s.state),
    });
    expect(session.transport).toBe("webrtc");
    expect(session.sessionId).toBe("sid-1");
    expect(statuses).toContain("provisioning");
    expect(statuses).toContain("live");
    // provisioned against the public origin, no double slash
    expect(calls[0].url).toBe("https://mage-media.example/sessions");
    await session.close();
    expect(calls.at(-1)?.url).toBe("https://mage-media.example/sessions/sid-1/close");
  });

  it("falls back to the WSS frame rail when ICE cannot connect", async () => {
    FakePc.mode = "stall";
    const { startIngest } = await import("../lib/ingest");
    const session = await startIngest({
      stream: mediaStream,
      mediaBaseUrl: "https://mage-media.example",
      rtcConnectTimeoutMs: 30,
    });
    expect(session.transport).toBe("ws");
    expect(FakeWebSocket.instances[0].url).toBe(
      "wss://mage-media.example/stream/sid-1"
    );
    // Frame timestamps must be wall-clock seconds (the media server feeds them
    // straight into the window tStart/tEnd and the control-plane ledger).
    await new Promise((r) => setTimeout(r, 10));
    const sent = FakeWebSocket.instances[0].sent[0];
    expect(sent.timestamp).toBeGreaterThan(1_000_000_000);
    await session.close();
  });

  it("trickles gathered ICE candidates to the media server (relay path)", async () => {
    FakePc.gathered = [
      "candidate:1 1 udp 2116026367 172.18.0.1 55904 typ host generation 0",
      "candidate:2 1 udp 1679818751 74.80.181.58 55904 typ srflx raddr 0.0.0.0 rport 0",
    ];
    const { startIngest } = await import("../lib/ingest");
    const seen: string[] = [];
    const session = await startIngest({
      stream: mediaStream,
      mediaBaseUrl: "https://mage-media.example",
      onIceCandidate: (dir, type) => seen.push(`${dir}:${type}`),
    });
    expect(session.transport).toBe("webrtc");
    // Every gathered candidate (incl. the late relay one) is posted to the
    // answerer's trickle route, addressed by the pcId from the answer.
    const trickled = calls.filter((c) => c.url.includes("/rtc/ice/"));
    expect(trickled.length).toBe(3);
    for (const c of trickled) {
      expect(c.url).toBe("https://mage-media.example/sessions/sid-1/rtc/ice/pc-1");
      expect(c.method).toBe("POST");
      expect(typeof c.body.candidate.candidate).toBe("string");
    }
    // Order is not meaningful (buffered candidates flush right after the
    // answer; a candidate gathered during setRemoteDescription goes direct).
    expect(
      trickled.map((c) => (c.body.candidate.candidate.match(/ typ (\w+)/) ?? [])[1]).sort()
    ).toEqual(["host", "relay", "srflx"]);
    expect(seen).toEqual(["local:host", "local:srflx", "local:relay"]);
    await session.close();
  });

  it("pushes prompt updates to the media session", async () => {
    const { startIngest } = await import("../lib/ingest");
    const session = await startIngest({
      stream: mediaStream,
      mediaBaseUrl: "https://mage-media.example",
    });
    await session.setPrompt("describe the crowd");
    const promptCall = calls.find((c) => c.url.endsWith("/sessions/sid-1/prompt"));
    expect(promptCall?.body).toEqual({ prompt: "describe the crowd" });
    await session.close();
  });

  it("releases the session and surfaces an error when both transports fail", async () => {
    FakePc.mode = "stall";
    (globalThis as any).WebSocket = class {
      static OPEN = 1;
      readyState = 1;
      constructor() {
        throw new Error("ws blocked");
      }
    };
    const { startIngest } = await import("../lib/ingest");
    await expect(
      startIngest({
        stream: mediaStream,
        mediaBaseUrl: "https://mage-media.example",
        rtcConnectTimeoutMs: 20,
      })
    ).rejects.toThrow(/ingest failed/);
    expect(calls.some((c) => c.url.endsWith("/sessions/sid-1/close"))).toBe(true);
  });
});
