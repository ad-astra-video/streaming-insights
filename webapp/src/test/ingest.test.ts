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
  connectionState = "new";
  closed = false;
  private listeners: (() => void)[] = [];
  constructor(public args: any) {}
  addTrack() {}
  addEventListener(_: string, fn: () => void) {
    this.listeners.push(fn);
  }
  removeEventListener() {}
  async createOffer() {
    return { type: "offer", sdp: "v=0" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    if (FakePc.mode === "connect") {
      this.connectionState = "connected";
      setTimeout(() => this.listeners.forEach((f) => f()), 0);
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
