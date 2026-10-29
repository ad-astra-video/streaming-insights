import cors from "@fastify/cors";
import { MEDIA_PORT } from "@streaming-insights/shared";
import Fastify from "fastify";

const app = Fastify({ logger: true });

// Public media origin must allow CORS for browser WebRTC clients.
await app.register(cors, { origin: true });

app.get("/api/health", async () => ({ status: "ok" }));

// Registered 2026-10: WebRTC ingest surface.
// Phase 2 wires werift offer/ice/ws here (reuses highlights.live rtc.ts).
app.get("/api/sessions", async () => ({ sessions: [] }));

app.listen({ port: Number(process.env.PORT ?? MEDIA_PORT), host: "0.0.0.0" });
