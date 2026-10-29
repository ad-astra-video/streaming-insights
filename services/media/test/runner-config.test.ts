import { describe, expect, it } from "vitest";
import { loadMediaConfig } from "../src/config.js";
import { HttpRunnerClient } from "../src/runner-client.js";

describe("media config: runner selection", () => {
  it("uses the REAL runner when RUNNER_BASE_URL is set (mock is opt-in)", () => {
    const cfg = loadMediaConfig({
      RUNNER_BASE_URL: "http://192.168.1.151:30000/v1",
    } as NodeJS.ProcessEnv);
    expect(cfg.runnerBase).toBe("http://192.168.1.151:30000/v1");
    // Regression: the deployed stack silently dispatched to the in-process mock
    // whenever MOCK_RUNNER was unset, so a "green" deploy never touched the GPU.
    expect(cfg.mockRunner).toBe(false);
  });

  it("honours an explicit MOCK_RUNNER=true opt-in", () => {
    const cfg = loadMediaConfig({
      RUNNER_BASE_URL: "http://runner:30000/v1",
      MOCK_RUNNER: "true",
    } as NodeJS.ProcessEnv);
    expect(cfg.mockRunner).toBe(true);
  });

  it("falls back to the mock only when no runner URL is configured", () => {
    const cfg = loadMediaConfig({} as NodeJS.ProcessEnv);
    expect(cfg.runnerBase).toBeUndefined();
    expect(cfg.mockRunner).toBe(true);
  });

  it("parses the committed ICE server list (STUN/TURN)", () => {
    const cfg = loadMediaConfig({
      RTC_ICE_SERVERS: "stun:stun.l.google.com:19302,turn:turn.example.com:3478",
    } as NodeJS.ProcessEnv);
    expect(cfg.rtcIceServers?.map((s) => s.urls)).toEqual([
      "stun:stun.l.google.com:19302",
      "turn:turn.example.com:3478",
    ]);
  });

  it("splits embedded TURN credentials into username/credential", () => {
    const cfg = loadMediaConfig({
      RTC_ICE_SERVERS: "stun:stun.l.google.com:19302,turn:alice:s3cr3t@136.33.135.223:3478?transport=udp",
    } as NodeJS.ProcessEnv);
    expect(cfg.rtcIceServers).toEqual([
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "turn:136.33.135.223:3478?transport=udp", username: "alice", credential: "s3cr3t" },
    ]);
  });
});

describe("HttpRunnerClient base normalization", () => {
  const cases = [
    "http://192.168.1.151:30000/v1",
    "http://192.168.1.151:30000/v1/",
    "http://192.168.1.151:30000",
    "http://192.168.1.151:30000/",
  ];

  for (const base of cases) {
    it(`posts to a single /v1/mage/window for base ${base}`, async () => {
      const seen: string[] = [];
      const original = globalThis.fetch;
      globalThis.fetch = (async (url: string | URL) => {
        seen.push(String(url));
        return new Response(
          JSON.stringify({
            pSpeak: 0.9,
            decision: "speak",
            tokensVisual: 258,
            tokensBaselineDense: 1152,
            tokensGenerated: 12,
            responseText: "ok",
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }) as typeof fetch;
      try {
        const client = new HttpRunnerClient(base);
        const out = await client.driveWindow(
          { seq: 0, tStart: 0, tEnd: 1, frames: [] } as any,
          "describe"
        );
        expect(seen).toEqual(["http://192.168.1.151:30000/v1/mage/window"]);
        expect(out.decision).toBe("speak");
      } finally {
        globalThis.fetch = original;
      }
    });
  }

  it("rejects a malformed runner outcome instead of writing bogus telemetry", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ pSpeak: 0.1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    try {
      const client = new HttpRunnerClient("http://runner:30000");
      await expect(
        client.driveWindow({ seq: 1, tStart: 1, tEnd: 2, frames: [] } as any)
      ).rejects.toThrow(/malformed/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
