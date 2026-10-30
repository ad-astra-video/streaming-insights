// Mage-VL window adapter.
//
// The media server (`services/media`) dispatches one codec-segment WINDOW to
// `POST /v1/mage/window` and expects the Phase 0b telemetry contract back
// (`pSpeak`, `decision`, sparse/dense visual token counts, generated tokens,
// `responseText`). The .151 box runs Mage-VL on stock SGLang, which only serves
// the OpenAI-compatible routes — there is no `/v1/mage/window` there. This
// module bridges the two: it turns a window's sampled JPEG frames into an
// OpenAI chat-completions request against the real GPU runner, then parses the
// model's proactive gate/response JSON back into the window contract.
//
// Token accounting is taken from the runner's own usage block: `tokensVisual`
// is the prompt tokens actually consumed minus the instruction-text tokens, and
// `tokensBaselineDense` is the analytic dense baseline (frames x
// DENSE_TOKENS_PER_FRAME) the savings dashboard compares against.

export interface WindowFrame {
  /** Frame receive timestamp (seconds). */
  ts: number;
  /** Base64 JPEG bytes of the sampled frame. */
  jpeg: string;
}

export interface WindowRequest {
  seq: number;
  tStart: number;
  tEnd: number;
  prompt?: string | null;
  frames: WindowFrame[];
}

export interface WindowOutcome {
  pSpeak: number;
  decision: "silent" | "speak";
  tokensVisual: number;
  tokensBaselineDense: number;
  tokensGenerated: number;
  responseText: string | null;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ParsedOutcomeOptions {
  gateThreshold: number;
  denseTokensPerFrame: number;
  frameCount: number;
  usage?: ChatUsage;
  /** True when the window carried a non-empty operator prompt. An operator
   *  prompt is a DIRECT question the assistant must answer, so a non-empty
   *  model answer (`text`) is spoken even if the model's self-assigned
   *  `pSpeak` is below the gate threshold. Proactive (no-prompt) windows keep
   *  the strict `pSpeak >= gateThreshold && text` gate. */
  hasPrompt?: boolean;
}

/** Rough token count for the instruction text, subtracted from the prompt
 *  tokens so `tokensVisual` reflects the visual rail only (~4 chars/token). */
function textTokenEstimate(text: string): number {
  return Math.ceil(text.length / 4);
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

/** The instruction block sent with the frames. Kept deterministic so the ledger
 *  comparison (dense baseline vs actual visual tokens) is reproducible. */
export function buildInstruction(req: WindowRequest, frames: WindowFrame[]): string {
  const span = Math.max(0, req.tEnd - req.tStart);
  const operatorPrompt = req.prompt?.trim();
  const lines = [
    "You are the Mage-VL proactive streaming assistant scoring ONE live-stream window.",
    `Window #${req.seq}, covering ${span.toFixed(2)}s with ${frames.length} sampled frame(s), oldest first.`,
  ];
  if (operatorPrompt) {
    // Prompted windows: the operator prompt is a DIRECT question. The order
    // below was validated against the live Mage-VL runner (ADAAAA-7586): with
    // the question placed LAST after a few-shot example the model answers in
    // `text` reliably; with the prompt embedded mid-instruction it returned
    // `{"pSpeak": 0.0, "text": null}` at temperature 0.
    lines.push(
      'Reply with JSON only, no prose: {"pSpeak": <number 0..1, confidence in your answer>, "text": <short spoken line, or null only when staying silent with no operator prompt>}',
    );
    lines.push(
      'Example exchange:\nUser: How many white cars are there?\nAssistant: {"pSpeak": 0.9, "text": "I see two white cars."}',
    );
    lines.push(`Now: ${operatorPrompt}`);
  } else {
    lines.push(
      "No operator prompt is set. Decide whether you should proactively SPEAK right now about what is happening in this window, and if so what to say.",
    );
    lines.push(
      'Reply with JSON only, no prose: {"pSpeak": <number 0..1, confidence you should speak now>, "text": <short spoken line, or null when staying silent>}',
    );
  }
  return lines.join("\n");
}

/** Build the OpenAI chat-completions payload the SGLang Mage-VL server accepts:
 *  one user message carrying the instruction text plus the window frames as
 *  `image_url` data URLs. */
export function buildChatPayload(
  req: WindowRequest,
  opts: { model: string; maxTokens: number; temperature: number; maxFrames: number },
): { body: Record<string, unknown>; instruction: string; frames: WindowFrame[] } {
  const frames = req.frames.slice(-Math.max(1, opts.maxFrames));
  const instruction = buildInstruction(req, frames);
  const content: Record<string, unknown>[] = [{ type: "text", text: instruction }];
  for (const f of frames) {
    content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${f.jpeg}` } });
  }
  return {
    body: {
      model: opts.model,
      messages: [{ role: "user", content }],
      max_tokens: opts.maxTokens,
      temperature: opts.temperature,
    },
    instruction,
    frames,
  };
}

/** Extract the first JSON object from model text, tolerating ``` fences and
 *  surrounding prose. Returns null when nothing parses. */
export function extractJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/```(?:json)?/gi, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(stripped.slice(start, end + 1));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Map the model's JSON reply + runner usage into the per-window contract.
 *  Unparseable output degrades to a SILENT window (never crashes a session) but
 *  still reports the tokens the runner actually spent. */
export function parseWindowOutcome(
  content: string,
  opts: ParsedOutcomeOptions,
  instructionTokens = 0,
): WindowOutcome {
  const obj = extractJsonObject(content);
  let pSpeak = 0;
  let text: string | null = null;
  if (obj) {
    const raw = typeof obj.pSpeak === "number" ? obj.pSpeak : parseFloat(String(obj.pSpeak ?? ""));
    pSpeak = clamp01(raw);
    const rawText = obj.text;
    if (typeof rawText === "string" && rawText.trim()) text = rawText.trim();
  }
  const decideSpeak = opts.hasPrompt
    ? text !== null
    : pSpeak >= opts.gateThreshold && text !== null;
  const promptTokens = opts.usage?.prompt_tokens ?? 0;
  const completionTokens = opts.usage?.completion_tokens ?? textTokenEstimate(content);
  return {
    pSpeak,
    decision: decideSpeak ? "speak" : "silent",
    // Visual rail the runner actually consumed (prompt tokens minus the text
    // instructions). Never negative if the runner reports a tiny prompt.
    tokensVisual: Math.max(0, promptTokens - instructionTokens),
    tokensBaselineDense: opts.frameCount * opts.denseTokensPerFrame,
    tokensGenerated: completionTokens,
    responseText: decideSpeak ? text : null,
  };
}

export class RunnerError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`runner upstream failed (${status}): ${detail}`);
  }
}

export interface MageClientOptions {
  upstream: string;
  model: string;
  maxTokens: number;
  temperature: number;
  maxFrames: number;
  gateThreshold: number;
  denseTokensPerFrame: number;
  requestTimeoutMs: number;
}

/** HTTP client for the Mage-VL SGLang runner. */
export class MageClient {
  constructor(
    private readonly cfg: MageClientOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async driveWindow(req: WindowRequest): Promise<WindowOutcome> {
    const { body, instruction, frames } = buildChatPayload(req, this.cfg);
    const url = `${this.cfg.upstream}/chat/completions`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.cfg.requestTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new RunnerError(504, ac.signal.aborted ? `runner timeout after ${this.cfg.requestTimeoutMs}ms` : msg);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new RunnerError(res.status, detail.slice(0, 400));
    }
    const json = (await res.json()) as any;
    const content: string = json?.choices?.[0]?.message?.content ?? "";
    return parseWindowOutcome(
      content,
      {
        gateThreshold: this.cfg.gateThreshold,
        denseTokensPerFrame: this.cfg.denseTokensPerFrame,
        frameCount: frames.length,
        usage: json?.usage,
        hasPrompt: Boolean(req.prompt && req.prompt.trim()),
      },
      textTokenEstimate(instruction),
    );
  }
}
