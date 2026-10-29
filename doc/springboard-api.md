# Springboard API (v1)

The structured live data-out feed for the Mage-VL streaming showcase. Any
workflow or app that is **not** the webapp can consume the per-window insights
produced by the control server and filter on `event.structured.*`.

The contract is versioned. The machine-readable JSON Schema is served at
`GET /api/schema` (`{"version":"v1","schema":{...}}`) and is the single source
of truth for the per-window event shape.

## Base

- Control server: `services/server`, default port `3100`.
- All routes are prefixed `/api`.
- CORS is enabled; a browser `EventSource` from any origin works.

## Endpoints

| Method | Path | Type | Description |
| --- | --- | --- | --- |
| GET | `/api/health` | JSON | Liveness probe. |
| GET | `/api/schema` | JSON | Versioned JSON Schema for the v1 event contract. |
| GET | `/api/sessions/:id/events` | SSE | Live feed of per-window events. Catch-up first, then new events as they occur. |
| GET | `/api/sessions/:id/events.ndjson` | NDJSON | Complete batch feed, one JSON event per line. |
| GET | `/api/sessions/:id/token-summary` | JSON | Aggregated per-session token ledger summary. |

Unknown session ids return `404`.

## Event payload (v1)

Each event is a per-window insight. It is the payload of every SSE
`data:` frame and the content of every NDJSON line.

```
sessionId   string  session this window belongs to
seq         int     monotonic window index within the session
tStart      number  window start, seconds from stream start
tEnd        number  window end, seconds from stream start
gate.pSpeak      number  gate confidence in [0,1]
gate.decision    "silent" | "speak"
tokens.visual          int  codec-native visual tokens
tokens.baselineDense   int  analytic dense baseline
tokens.generated       int  VLM-generated tokens (0 on a silent window)
tokens.savedVsBaseline number  1 - visual/baselineDense (savings fraction)
prompt        string  optional injected prompt
event.type    "response"
event.text    string  decoded caption (empty on silence)
event.structured  object  free-form payload — primary filter target
```

`event` is optional (a window may be silent). When present,
`event.structured` is a free-form object that is the key filter axis for
downstream consumers.

## Reference consumer — browser (EventSource)

```js
const sessionId = "<session-id>";
const es = new EventSource(`/api/sessions/${sessionId}/events`);

es.addEventListener("window", (e) => {
  const evt = JSON.parse(e.data);
  // Filter on the structured payload.
  const tile = evt.event?.structured?.tile;
  if (evt.gate.decision === "speak" && tile === "person") {
    console.log("person seen:", evt.event.text);
  }
});
es.onerror = () => console.error("live feed error");
```

## Reference consumer — Node (fetch NDJSON batch)

```js
const sessionId = "<session-id>";
const res = await fetch(`http://localhost:3100/api/sessions/${sessionId}/events.ndjson`);
if (!res.ok) throw new Error(`feed failed: ${res.status}`);

const text = await res.text();
const events = text
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

// Filter on the structured payload.
const speaks = events.filter((e) => e.gate.decision === "speak");
const carFrames = events.filter((e) => e.event?.structured?.tile === "car");
console.log(`${speaks.length} speak windows, ${carFrames.length} car frames`);
```

## Versioning

- Current contract version: `v1` (`CONTRACT_VERSION` in `packages/shared`).
- The JSON Schema lives in `packages/shared/src/contract.ts` and is served at
  `/api/schema`. Bump `CONTRACT_VERSION` and the schema together when the
  event shape changes.
- Route constants live in `packages/shared/src/index.ts` (`ROUTES`); keep the
  server handlers and the shared `ROUTES` in sync.

## Implementation

- Server: `services/server/src/app.ts` (`buildApp`), boot `src/index.ts`.
- Event store: the `events` table (`packages/db`), `payload` holds the full v1
  event. The live SSE feed polls the event store for new rows.
- Token summary: `token_ledger` table aggregation in `services/server/src/app.ts`.
- Tests: `services/server/test/springboard.test.ts` (boots embedded PGlite,
  seeds events + ledger, and asserts the NDJSON feed, SSE live feed,
  token-summary aggregation, 404s, and the versioned schema).
