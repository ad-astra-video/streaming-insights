import { describe, expect, it } from "vitest";
import { MockRunnerClient, HttpRunnerClient } from "../src/runner-client";
import type { CodecWindow } from "../src/windows";

function windowWith(sizes: number[]): CodecWindow {
  return {
    seq: 0,
    tStart: 0,
    tEnd: sizes.length,
    frames: sizes.map((n, i) => ({ seq: i, ts: i, jpeg: Buffer.alloc(n) })),
  };
}

describe("MockRunnerClient", () => {
  it("stays SILENT on a static window (identical frame sizes -> ~0 generated tokens, null text)", async () => {
    const r = new MockRunnerClient();
    const out = await r.driveWindow(windowWith([200, 200, 200, 200]));
    expect(out.decision).toBe("silent");
    expect(out.pSpeak).toBe(0);
    expect(out.tokensGenerated).toBe(0);
    expect(out.responseText).toBeNull();
    expect(out.tokensVisual).toBe(4 * 129);
    expect(out.tokensBaselineDense).toBe(4 * 576);
  });

  it("runs the VLM (SPEAK) on a moving window (varied frame sizes)", async () => {
    const r = new MockRunnerClient();
    const out = await r.driveWindow(windowWith([90, 340, 120, 500]));
    expect(out.decision).toBe("speak");
    expect(out.pSpeak).toBeGreaterThanOrEqual(0.5);
    expect(out.tokensGenerated).toBeGreaterThan(0);
    expect(out.responseText).toBeTruthy();
  });

  it("honours the injected gate threshold and token constants", async () => {
    const r = new MockRunnerClient({
      gateThreshold: 0.9,
      denseTokensPerFrame: 1000,
      sparseTokensPerFrame: 200,
      speakTokensPerWindow: 12,
    });
    // a moderate-variation window (~0.70 p_speak) speaks at 0.5 but stays
    // silent at the injected 0.9 threshold.
    const out = await r.driveWindow(windowWith([100, 150, 200, 250]));
    expect(out.decision).toBe("silent");
    expect(out.tokensVisual).toBe(4 * 200);
    expect(out.tokensBaselineDense).toBe(4 * 1000);
  });
});

describe("HttpRunnerClient", () => {
  it("posts the window and reads back the telemetry contract", async () => {
    const seen: any[] = [];
    const base = "http://runner.test";
    // Stub global fetch to record the request and return a valid outcome.
    const orig = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      seen.push({ url: String(url), body: init?.body });
      return new Response(JSON.stringify({ pSpeak: 0.8, decision: "speak", tokensVisual: 129, tokensBaselineDense: 576, tokensGenerated: 48, responseText: "hello" }), { status: 200 });
    }) as any;
    try {
      const c = new HttpRunnerClient(base);
      const out = await c.driveWindow(windowWith([100, 200]), "track the ball");
      expect(seen[0].url).toBe(base + "/v1/mage/window");
      const body = JSON.parse(seen[0].body);
      expect(body.seq).toBe(0);
      expect(body.prompt).toBe("track the ball");
      expect(body.frames).toHaveLength(2);
      expect(out.decision).toBe("speak");
      expect(out.responseText).toBe("hello");
    } finally {
      globalThis.fetch = orig;
    }
  });

  it("throws on a non-2xx / malformed runner response", async () => {
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "boom" }), { status: 503 })) as any;
    try {
      const c = new HttpRunnerClient("http://runner.test");
      await expect(c.driveWindow(windowWith([100]))).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = orig;
    }
  });
});
