# Mage-VL Phase 0b — Model Spike Decisions (ADAAAA-7547)

Status: **DECISIONS LOCKED — measurement BLOCKED on box infra (see bottom).**

This is the honest gate for Phases 1–3. It records the runner runtime, the
telemetry hook, and the dense-baseline method, plus the measured-confirmation
status. Decisions are grounded in the upstream `microsoft/Mage` `mage_vl`
reference implementation (Apache-2.0) and the live `.151` box (`5090x3`).

---

## 1. Runner runtime — DECISION

**Use SGLang `feat/mage-vl` (kcz358/sglang) as the production serving runtime,
with the Transformers `inference_streaming.py` reference as the streaming
telemetry-contract source.**

Two distinct runtimes are involved. The issue's framing offered a binary
"Transformers reference streaming script OR native llama.cpp StreamMind", but
the upstream release does not ship a llama.cpp/StreamMind C++ port — Mage-VL
ships its proactive gate inside the Transformers model as
`model.streammind_gate_forward_segments()` and serves the OpenAI-compatible
path through SGLang. Concretely:

- **Reference streaming path (what defines the per-window contract):**
  `mage_vl/inference_streaming.py` (Transformers + `streammind_gate`). This is
  the canonical, Apache-2.0 reference. It splits a video into non-overlapping
  segments, scores the whole causal segment stream through the gate once
  (`streammind_gate_forward_segments`), and runs standard `model.generate`
  only on segments whose `p_speak` crosses `--gate_threshold` (default 0.5).
  **Use this to verify the streaming telemetry and to measure single-stream
  per-window VRAM / real-time factor (RTF).**
- **Production multi-stream serving runtime (what serves 3 streams / 5090):**
  SGLang `feat/mage-vl`. It is the OpenAI-compatible serving runtime the
  upstream docs use for online inference and is the only path that provides the
  concurrent batching needed to serve 3 streams on one GPU. Build requirements:
  `protobuf-compiler` + Rust 1.90.0 toolchain.

> Note for the plan: the "native C++/llama.cpp StreamMind runtime" branch of
> the decision is **not** a released Mage-VL runtime. Do not plan a llama.cpp
> build for Phase 1–3; plan SGLang `feat/mage-vl`.

### Why SGLang for production
- Concurrency/batching for 3 streams per 5090 (the capacity gate).
- OpenAI-compatible API (`/v1`), matches the media/orchestrator dispatch design.
- Upstream-recommended serving path; `--trust-remote-code` loads the Mage-VL
  modeling code + gate.

### Fallback
If the `.151` box cannot host the SGLang build (95% disk, no Rust/protoc), the
Transformers `inference_streaming.py` path still proves instrumentability and
single-stream RTF; it just cannot batch 3 streams per GPU. Not a substitute for
the capacity gate.

---

## 2. Telemetry hook — DECISION

**Emit one machine-readable NDJSON telemetry line per window from the runner.**

The reference script prints human-readable lines:
`[t=0.0-8.0s] gate=silence (p=0.19)` / `gate=response (p=0.55) -> <text>`.
These carry `p_speak` + decision but are not suitable as the wire contract and
do **not** include token counts. The hook we standardize on:

```json
{"window":0,"tStart":0.0,"tEnd":8.0,"pSpeak":0.19,"decision":"silent","tokensVisual":40,"tokensGenerated":0,"responseText":null}
{"window":1,"tStart":8.0,"tEnd":16.0,"pSpeak":0.55,"decision":"speak","tokensVisual":312,"tokensGenerated":64,"responseText":"The video features ..."}
```

- **`pSpeak`** = `softmax(gate_logits at segment boundary)[:,1]`, exactly as the
  reference computes it (class 1 is "speak"; decision = `pSpeak >= threshold`).
- **`decision`** = `silent` | `speak` (boolean of the gate crossing `τ`).
- **`tokensVisual`** = `int(segment["image_grid_thw"][:,0].sum())` — the actual
  sparse codec-native visual-token count for the window (available in the
  reference `lengths`/`boundaries` computation).
- **`tokensGenerated`** = `model.generate(...)` output length minus prompt
  length (`new_tokens.shape[0]` in `generate_current_segment`). The reference
  does **not** print this today — it is available on the returned tensor and is
  a one-line instrumentation addition. This satisfies "token counts are
  obtainable (usage field or instrumentation)".
- **`responseText`** = the decoded generated caption (null on silence).

The control server / `token_ledger` consumes this NDJSON stream. The
`packages/token-savings` engine (`WindowEvent`) is typed 1:1 to this contract —
the runner emits `WindowEvent` rows, the engine derives savings.

---

## 3. Dense baseline method — DECISION

**Analytic patch-count estimate; no need to run a dense model.**

Mage-ViT tokenizes on a fixed `16×16` patch grid with `max_pixels` capping
resolution (`codec_config={"patch":16,"max_pixels":150000}` in the reference).
The dense (uniform frame-sampling) visual-token baseline for a window is taken
as the fully-sampled patch count for the same window at the target resolution:

```
tokensBaselineDense(window) = framesInWindow × ceil(h/16) × ceil(w/16)
```

where `framesInWindow = (tEnd - tStart) × target_fps` (the reference's
`cur_fps`, default 2) and `(h,w)` is the analytic resolution derived from
`max_pixels`. This is computed **analytically from the window's time span and
the patch grid — no dense forward pass**. Then:

- `tokensSaved = max(tokensBaselineDense − tokensVisual, 0)`  (codec sparsity)
- `savingsPct = tokensSaved / tokensBaselineDense`
- Gate savings = silent windows generate ~0 `tokensGenerated`.

This is exactly the model implemented in `packages/token-savings` (the
`WindowEvent` `tokensVisual`/`tokensBaselineDense`/`tokensGenerated` fields and
`windowSavings`/`cumulativeSavings`/`sessionCounters`). The runner supplies real
`tokensVisual` + `tokensGenerated`; the dense baseline is derived, so no extra
compute or second model is required for the savings dashboard.

---

## 4. Measured confirmation — BLOCKED

The remaining acceptance item — measured per-stream VRAM and per-window RTF
confirming one 5090 serves 3 concurrent streams — **cannot be produced on the
`.151` box (`5090x3`) until two infra conditions are fixed** (verified live):

1. **GPU driver/library mismatch (no CUDA).** Kernel module is `580.105.08`
   but the userspace driver installed is `580.196.07`
   (`/proc/driver/nvidia/version` vs `nvidia-driver-580-open 580.196.07`).
   `nvidia-smi` fails with `Failed to initialize NVML: Driver/library version
   mismatch`. Any CUDA load (torch / SGLang) will fail. Fix requires loading a
   matching kernel module — a **reboot** on a box up 12 days running the
   `univideo-*` / `video-creator-*` containers — or a userland downgrade. Both
   are disruptive on shared infra and need an ops call.
2. **Disk at 95% (50G free)** of `/dev/nvme0n1p2` (`/srv/video-creator` =
   539G). Insufficient headroom to pull `microsoft/Mage-VL` (~10 GB) and build
   SGLang (protobuf-compiler + Rust + heavy cmake). Needs an ops cleanup pass.

### Unblock owner / action
- **Owner:** board / ops on the `.151` (`5090x3`) box.
- **Action:** (a) resolve the NVIDIA driver/library mismatch (reboot to load a
  matching kernel module, or align userland to `580.105.08`), and (b) free
  ≥ 60 GB on `/` (e.g. prune `/srv/video-creator`). Then rerun this
  phase's measurement step.
- During the same pass stage the Mage-VL pull + SGLang build (protobuf-compiler
  + Rust 1.90.0).

---

## What is done vs. blocked

Done (this phase, verifiable):
- Runner runtime decision (§1), telemetry hook (§2), dense-baseline method (§3).
- streaming-insights repo scaffold (packages layout + `packages/token-savings`
  engine + Dockerfile + CI) — see repo.

Blocked (acceptance gate):
- Measured per-stream VRAM / per-window RTF confirming 3 streams per 5090.
