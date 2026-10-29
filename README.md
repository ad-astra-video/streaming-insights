# streaming-insights

Bare-bones webapp + streaming showcase for [microsoft/Mage-VL](https://huggingface.co/microsoft/Mage-VL),
mirroring the highlights.live server/DB + media-server split.

## Packages

- `packages/token-savings` — the token-savings engine (the core insight):
  gate-silent windows cost ~0 generated tokens; Mage-ViT sparse-vs-dense codec
  savings; cumulative savings %; p_speak sparkline series with silent/speak
  bands; why-silent explainer; separate stream-minutes vs tokens-avoided
  counters. Pure, UI-agnostic, and unit-tested.
- `services/server` — the control plane (Fastify + Postgres): sessions,
  prompts, the `token_ledger`, the structured `events` store (the springboard
  data-out contract), runner registration/heartbeat and slot reservation
  (`/stream-sessions`), and `/health` with capacity.
- `services/media` — the media server (Fastify + werift) with its own public
  origin. Terminates WebRTC ingest (`POST /sessions`, `/sessions/:sid/rtc/offer`,
  `/rtc/ice/:pcId`, `/stream/:sid` ws), decodes frames into codec-segment
  windows, reserves a runner slot via the control server, dispatches each
  window to a Mage-VL runner, and POSTs per-window gate/token/text events to
  the control server. With no `RUNNER_BASE_URL` it dispatches to an in-process
  mock runner so the ingest→window→event path runs without a GPU.

## Develop

```sh
pnpm install
pnpm test
pnpm -r typecheck
```
