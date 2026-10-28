# streaming-insights

Bare-bones webapp + streaming showcase for [microsoft/Mage-VL](https://huggingface.co/microsoft/Mage-VL),
mirroring the highlights.live server/DB + media-server split.

## Packages

- `packages/token-savings` — the token-savings engine (the core insight):
  gate-silent windows cost ~0 generated tokens; Mage-ViT sparse-vs-dense codec
  savings; cumulative savings %; p_speak sparkline series with silent/speak
  bands; why-silent explainer; separate stream-minutes vs tokens-avoided
  counters. Pure, UI-agnostic, and unit-tested.

## Develop

```sh
pnpm install
pnpm test
pnpm -r typecheck
```
