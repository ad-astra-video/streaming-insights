/**
 * Versioned data-out contract ("springboard").
 *
 * `streamWindowEventJsonSchema` is the machine-readable JSON Schema (draft
 * 2020-12) for the per-window NDJSON/SSE event emitted on the live feed and
 * the batch feed. It is the stable v1 contract external consumers validate
 * against and filter on (notably `event.structured.*`).
 */
export const CONTRACT_VERSION = "v1";

export const streamWindowEventJsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://streaming-insights.adhoc/contracts/stream-window-event.v1.schema.json",
  title: "StreamWindowEvent",
  description:
    "Per-window insight emitted for a stream session. One line per event in the NDJSON feed, one event per SSE `data:` frame on the live feed.",
  type: "object",
  required: ["sessionId", "seq", "tStart", "tEnd", "gate", "tokens"],
  properties: {
    sessionId: { type: "string" },
    seq: { type: "integer", minimum: 0, description: "Monotonic window index within the session." },
    tStart: { type: "number", description: "Window start, seconds from stream start." },
    tEnd: { type: "number", description: "Window end, seconds from stream start." },
    gate: {
      type: "object",
      required: ["pSpeak", "decision"],
      properties: {
        pSpeak: { type: "number", minimum: 0, maximum: 1, description: "Gate confidence that the window warrants a System-2 response." },
        decision: { type: "string", enum: ["silent", "speak"] },
      },
    },
    tokens: {
      type: "object",
      required: ["visual", "baselineDense", "generated", "savedVsBaseline"],
      properties: {
        visual: { type: "integer", minimum: 0, description: "Codec-native visual token count." },
        baselineDense: { type: "integer", minimum: 0, description: "Analytic dense baseline (no dense model run)." },
        generated: { type: "integer", minimum: 0, description: "VLM-generated tokens (0 for a silent gate window)." },
        savedVsBaseline: { type: "number", description: "1 - visual / baselineDense, the codec-token savings fraction." },
      },
    },
    prompt: { type: "string", description: "Injected user prompt for the window, if any." },
    event: {
      type: "object",
      required: ["type", "text"],
      properties: {
        type: { type: "string", enum: ["response"] },
        text: { type: "string" },
        structured: {
          type: "object",
          additionalProperties: true,
          description: "Free-form structured payload, the primary filter target for external consumers.",
        },
      },
    },
  },
} as const;
