// Mage-VL window adapter HTTP surface.
//
//   POST /v1/mage/window   one codec window -> WindowOutcome (contract below)
//   GET  /health           liveness for the compose probe
//   GET  /api/health       alias (the compose probes use /api/health on the
//                          other services, so both are served here too)
//
// The media server's HttpRunnerClient posts to `${RUNNER_BASE_URL}/v1/mage/window`
// and validates every numeric field + the decision enum, so the response shape
// is fixed: { pSpeak, decision, tokensVisual, tokensBaselineDense,
// tokensGenerated, responseText }.
import Fastify, { type FastifyInstance } from "fastify";
import type { AdapterConfig } from "./config.js";
import { MageClient, RunnerError, type WindowRequest } from "./mage.js";

export interface AdapterDeps {
  /** Runner client; defaults to a MageClient bound to the adapter config. */
  runner?: Pick<MageClient, "driveWindow">;
}

function validWindow(body: unknown): string | null {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const w = body as Partial<WindowRequest>;
  if (!Array.isArray(w.frames) || w.frames.length === 0) return "frames must be a non-empty array";
  for (const f of w.frames) {
    if (!f || typeof f.jpeg !== "string" || f.jpeg.length === 0) return "each frame needs base64 jpeg";
    if (typeof f.ts !== "number") return "each frame needs a numeric ts";
  }
  if (typeof w.seq !== "number") return "seq must be a number";
  return null;
}

export function buildAdapterApp(cfg: AdapterConfig, deps: AdapterDeps = {}): FastifyInstance {
  const runner = deps.runner ?? new MageClient(cfg);
  const app = Fastify({ logger: false });

  const health = async () => ({ status: "ok", upstream: cfg.upstream, model: cfg.model });
  app.get("/health", health);
  app.get("/api/health", health);

  app.post("/v1/mage/window", async (req, reply) => {
    const bad = validWindow(req.body);
    if (bad) return reply.status(400).send({ error: bad });
    try {
      const outcome = await runner.driveWindow(req.body as WindowRequest);
      return reply.status(200).send(outcome);
    } catch (e) {
      if (e instanceof RunnerError) {
        return reply.status(502).send({ error: e.detail, upstreamStatus: e.status });
      }
      const msg = e instanceof Error ? e.message : String(e);
      return reply.status(502).send({ error: msg });
    }
  });

  return app;
}
