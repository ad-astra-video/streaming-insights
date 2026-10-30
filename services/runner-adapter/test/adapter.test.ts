import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadAdapterConfig } from "../src/config.js";
import {
  buildChatPayload,
  buildInstruction,
  extractJsonObject,
  MageClient,
  parseWindowOutcome,
  type WindowRequest,
} from "../src/mage.js";
import { buildAdapterApp } from "../src/server.js";

/** Minimal base64 "JPEG" — the adapter never decodes frames, it forwards them. */
const JPEG = Buffer.from("fake-jpeg-bytes").toString("base64");

function windowReq(overrides: Partial<WindowRequest> = {}): WindowRequest {
  return {
    seq: 3,
    tStart: 10,
    tEnd: 12,
    prompt: null,
    frames: [
      { ts: 10, jpeg: JPEG },
      { ts: 11, jpeg: JPEG },
    ],
    ...overrides,
  };
}

interface Stub {
  server: Server;
  url: string;
  bodies: any[];
}

async function stubUpstream(status: number, reply: unknown): Promise<Stub> {
  const bodies: any[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}/v1`, bodies };
}

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function openStub(status: number, reply: unknown): Promise<Stub> {
  const s = await stubUpstream(status, reply);
  open.push(s.server);
  return s;
}

describe("adapter config", () => {
  it("defaults to the .151 SGLang runner and the Mage-VL model", () => {
    const cfg = loadAdapterConfig({} as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(4180);
    expect(cfg.upstream).toBe("http://127.0.0.1:30000/v1");
    expect(cfg.model).toBe("microsoft/Mage-VL");
    expect(cfg.gateThreshold).toBe(0.5);
    expect(cfg.denseTokensPerFrame).toBe(576);
  });

  it("strips a trailing slash from the upstream base", () => {
    const cfg = loadAdapterConfig({ RUNNER_UPSTREAM: "http://runner:30000/v1/" } as NodeJS.ProcessEnv);
    expect(cfg.upstream).toBe("http://runner:30000/v1");
  });
});

describe("chat payload", () => {
  it("sends the instruction text plus one image part per frame", () => {
    const { body, frames } = buildChatPayload(windowReq(), {
      model: "microsoft/Mage-VL",
      maxTokens: 64,
      temperature: 0,
      maxFrames: 4,
    });
    expect(body.model).toBe("microsoft/Mage-VL");
    expect(body.max_tokens).toBe(64);
    const content = (body.messages as any[])[0].content as any[];
    expect(content[0].type).toBe("text");
    expect(content[0].text).toContain("Window #3");
    const images = content.filter((c) => c.type === "image_url");
    expect(images).toHaveLength(2);
    expect(images[0].image_url.url).toBe(`data:image/jpeg;base64,${JPEG}`);
    expect(frames).toHaveLength(2);
  });

  it("keeps only the newest frames when a window exceeds maxFrames", () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ ts: i, jpeg: JPEG }));
    const { frames: used } = buildChatPayload(windowReq({ frames }), {
      model: "m",
      maxTokens: 8,
      temperature: 0,
      maxFrames: 2,
    });
    expect(used.map((f) => f.ts)).toEqual([3, 4]);
  });

  it("carries the operator prompt into the instruction as a direct question", () => {
    const text = buildInstruction(windowReq({ prompt: "describe the road" }), windowReq().frames);
    // Prompted layout (live-model-validated): schema, few-shot example, then the
    // question LAST. The model answers reliably only with this order.
    expect(text).toContain("Now: describe the road");
    expect(text).toContain('Example exchange:\nUser: How many white cars are there?\nAssistant: {"pSpeak": 0.9, "text": "I see two white cars."}');
    expect(text.indexOf("Example exchange")).toBeLessThan(text.indexOf("Now: describe the road"));
    expect(text).not.toContain("No operator prompt is set");
  });

  it("uses proactive (no-prompt) wording when no prompt is set", () => {
    const text = buildInstruction(windowReq(), windowReq().frames);
    expect(text).toContain("No operator prompt is set");
    expect(text).not.toContain("Now: ");
    expect(text).not.toContain("Example exchange");
  });
});

describe("outcome parsing", () => {
  const opts = { gateThreshold: 0.5, denseTokensPerFrame: 576, frameCount: 2 };

  it("maps a speak decision and the runner usage tokens", () => {
    const out = parseWindowOutcome(
      '{"pSpeak": 0.82, "text": "A red car cuts across."}',
      { ...opts, usage: { prompt_tokens: 300, completion_tokens: 12 } },
      24,
    );
    expect(out.decision).toBe("speak");
    expect(out.pSpeak).toBeCloseTo(0.82);
    expect(out.responseText).toBe("A red car cuts across.");
    expect(out.tokensVisual).toBe(276);
    expect(out.tokensBaselineDense).toBe(1152);
    expect(out.tokensGenerated).toBe(12);
  });

  it("treats a low gate as silent and nulls the text", () => {
    const out = parseWindowOutcome('{"pSpeak": 0.1, "text": "should not speak"}', opts);
    expect(out.decision).toBe("silent");
    expect(out.responseText).toBeNull();
  });

  it("stays silent when the model has no line to say, even with high pSpeak", () => {
    const out = parseWindowOutcome('{"pSpeak": 0.95, "text": null}', opts);
    expect(out.decision).toBe("silent");
    expect(out.responseText).toBeNull();
  });

  it("speaks a model answer to an operator prompt even when pSpeak is below the gate", () => {
    const out = parseWindowOutcome(
      '{"pSpeak": 0.1, "text": "I can see 4 red players."}',
      { ...opts, hasPrompt: true },
    );
    expect(out.decision).toBe("speak");
    expect(out.responseText).toBe("I can see 4 red players.");
  });

  it("stays silent for a prompted window when the model gives no answer text", () => {
    const out = parseWindowOutcome('{"pSpeak": 0.0, "text": null}', { ...opts, hasPrompt: true });
    expect(out.decision).toBe("silent");
    expect(out.responseText).toBeNull();
  });

  it("keeps the strict gate for proactive (no-prompt) windows", () => {
    const out = parseWindowOutcome('{"pSpeak": 0.1, "text": "proactive line"}', opts);
    expect(out.decision).toBe("silent");
    expect(out.responseText).toBeNull();
  });

  it("parses fenced JSON and clamps out-of-range confidence", () => {
    const out = parseWindowOutcome("```json\n{\"pSpeak\": 7, \"text\": \"hi\"}\n```", opts);
    expect(out.pSpeak).toBe(1);
    expect(out.decision).toBe("speak");
  });

  it("degrades unparseable model output to silent instead of throwing", () => {
    const out = parseWindowOutcome("I cannot help with that.", { ...opts, usage: { prompt_tokens: 200 } }, 20);
    expect(out.decision).toBe("silent");
    expect(out.pSpeak).toBe(0);
    expect(out.tokensVisual).toBe(180);
  });

  it("never reports negative visual tokens", () => {
    const out = parseWindowOutcome('{"pSpeak":0,"text":null}', { ...opts, usage: { prompt_tokens: 5 } }, 50);
    expect(out.tokensVisual).toBe(0);
  });

  it("extractJsonObject returns null for prose without an object", () => {
    expect(extractJsonObject("no json here")).toBeNull();
  });
});

describe("MageClient against a stub SGLang upstream", () => {
  const cfg = {
    upstream: "",
    model: "microsoft/Mage-VL",
    maxTokens: 128,
    temperature: 0,
    maxFrames: 4,
    gateThreshold: 0.5,
    denseTokensPerFrame: 576,
    requestTimeoutMs: 5000,
  };

  it("posts to /v1/chat/completions and returns the window contract", async () => {
    const stub = await openStub(200, {
      choices: [{ message: { role: "assistant", content: '{"pSpeak": 0.91, "text": "Two cars ahead."}' } }],
      usage: { prompt_tokens: 320, completion_tokens: 9 },
    });
    const client = new MageClient({ ...cfg, upstream: stub.url });
    const out = await client.driveWindow(windowReq());
    expect(stub.bodies[0].url).toBe("/v1/chat/completions");
    expect(stub.bodies[0].body.model).toBe("microsoft/Mage-VL");
    expect(out.decision).toBe("speak");
    expect(out.responseText).toBe("Two cars ahead.");
    expect(out.tokensBaselineDense).toBe(1152);
  });

  it("surfaces an upstream failure as a RunnerError with the upstream status", async () => {
    const stub = await openStub(500, { error: "boom" });
    const client = new MageClient({ ...cfg, upstream: stub.url });
    await expect(client.driveWindow(windowReq())).rejects.toMatchObject({ status: 500 });
  });

  it("surfaces a refused connection as a RunnerError", async () => {
    const client = new MageClient({ ...cfg, upstream: "http://127.0.0.1:1/v1" });
    await expect(client.driveWindow(windowReq())).rejects.toMatchObject({ status: 504 });
  });
});

describe("adapter HTTP surface", () => {
  const cfg = loadAdapterConfig({ RUNNER_UPSTREAM: "http://runner:30000/v1" } as NodeJS.ProcessEnv);

  it("serves health on both probe paths", async () => {
    const app = buildAdapterApp(cfg);
    for (const path of ["/health", "/api/health"]) {
      const res = await app.inject({ method: "GET", url: path });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok", model: "microsoft/Mage-VL" });
    }
    await app.close();
  });

  it("rejects a window with no frames", async () => {
    const app = buildAdapterApp(cfg);
    const res = await app.inject({ method: "POST", url: "/v1/mage/window", payload: { seq: 0, frames: [] } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns the window outcome for a valid window", async () => {
    const app = buildAdapterApp(cfg, {
      runner: { driveWindow: async () => ({
        pSpeak: 0.7,
        decision: "speak",
        tokensVisual: 258,
        tokensBaselineDense: 1152,
        tokensGenerated: 10,
        responseText: "hello",
      }) },
    });
    const res = await app.inject({ method: "POST", url: "/v1/mage/window", payload: windowReq() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ decision: "speak", tokensVisual: 258 });
    await app.close();
  });
});
