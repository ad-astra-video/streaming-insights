# streaming-insights

Mage-VL proactive-streaming showcase: live streams -> per-window gate/token
insights. A control plane that ingests one or more live video streams, runs
them through the Mage-VL streammind gate on SGLang (`feat/mage-vl`), and
surfaces per-window **token savings** (codec-native visual tokens vs. the
analytic dense baseline + VLM-generated tokens).

Grounded in the Phase 0b model spike ([ADAAAA-7547](/ADAAAA/issues/ADAAAA-7547))
on the `.151` box (5090 x3). Acceptance gate confirmed: **3 streams per
5090**, gate fires only on `--video_backend codec` with **<=16s windows**.

## Pinned runtime config (measured)

| Setting | Value | Why |
| --- | --- | --- |
| Runner runtime | SGLang `feat/mage-vl` (kcz358/sglang) | Multi-stream serving, OpenAI-compatible |
| Video backend | `--video_backend codec` | Gate never fires on `frames` (pSpeak <= 0.002 measured) |
| Window size | `--segment_sec` 8 (<= 16s) | 8s optimal; a 30s window does not trigger the gate |
| Gate | `pSpeak >= 0.5` => `speak` | `softmax(gate_logits at segment boundary)[:, 1]` |
| Capacity | 3 streams / 5090 | Measured ~0.07 RTF/stream, no per-stream VRAM growth |

## Token savings model

Per window the runner emits one NDJSON telemetry line:

```json
{"window":1,"tStart":8.0,"tEnd":16.0,"pSpeak":0.551,"decision":"speak","tokensVisual":312,"tokensGenerated":64,"responseText":"The video features ..."}
```

- `tokensVisual` = `int(segment["image_grid_thw"][:,0].sum())` (codec-native)
- `tokensGenerated` = `model.generate(...)` output length - prompt length (0 on silence)
- `tokensBaselineDense` = `framesInWindow * ceil(h/16) * ceil(w/16)` — analytic, no dense run
  (`framesInWindow = (tEnd - tStart) * effective_fps`; Mage-ViT uses a 16x16 patch grid)
- `windowSavings` = `max(tokensBaselineDense - tokensVisual, 0)`

`packages/token-savings` implements the `WindowEvent` insight and the
`token_ledger` consumer (`SessionLedger`) with unit tests. The control server
wires the NDJSON consumer at `POST /api/sessions/:sessionId/events.ndjson` and
aggregates `GET /api/sessions/:sessionId/token-summary`.

## Repo layout

```
packages/
  shared/          # constants, zod contracts (StreamWindowEvent), routes
  events/          # live-feed event types (SSE/NDJSON)
  db/              # drizzle schema (sessions, token_ledger, events, runners)
  token-savings/   # WindowEvent + dense baseline + SessionLedger (token_ledger)
services/
  server/          # control server (Fastify, port 3100): ledger consumer + summaries
  media/           # media service (Fastify, port 4070): WebRTC ingest (Phase 2)
Dockerfile         # lightweight control/service image
Dockerfile.runner  # SGLang feat/mage-vl GPU image (pinned .151 config)
.github/workflows/ci.yml  # pnpm install + typecheck + build + test
```

## Dev

```sh
pnpm install
pnpm dev              # control (3100) + media (4070)
pnpm -r typecheck
pnpm -r build
pnpm -r test
```

Leave `DATABASE_URL` unset in dev for the embedded PGlite path.

## Docker

```sh
# control/service image
docker build -t streaming-insights:control .
docker run -p 3100:3100 streaming-insights:control
docker run -p 4070:4070 streaming-insights:control node services/media/dist/index.js

# Mage-VL runner image (GPU; pre-built mage-vl-sglang:cu130 on the .151 box)
docker build -f Dockerfile.runner -t mage-vl-sglang:cu130 .
docker run --gpus all -p 30000:30000 -v /models:/models mage-vl-sglang:cu130
```

## Status

Phase 0b (model spike) is complete and the acceptance gate is met. Phases 1-3
(webapp + real WebRTC ingest + dashboard) build on this scaffold.

## License

See `LICENSE`.
