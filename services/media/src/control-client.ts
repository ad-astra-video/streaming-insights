/** WindowOutcome + timing -> the control server's token_ledger write payload. */
export interface LedgerWindowPayload {
  seq: number;
  tStart: number;
  tEnd: number;
  pSpeak?: number;
  decision?: "silent" | "speak";
  tokensVisual?: number;
  tokensBaselineDense?: number;
  tokensGenerated?: number;
  prompt?: string;
  responseText?: string;
}

/** The springboard data-out event payload (gate + tokens + text). */
export interface EventPayload {
  seq: number;
  tStart: number;
  tEnd: number;
  gate: { pSpeak: number; decision: "silent" | "speak" };
  tokens: { visual: number; baselineDense: number; generated: number; savedVsBaseline: number };
  prompt?: string;
  event: { type: string; text: string | null; structured?: Record<string, unknown> | null };
}

export interface ReservedSession {
  session: { id: string; status?: string; source?: string };
  runner: { id?: string; name?: string; status?: string; slotsUsed?: number; capacity?: number };
}

/**
 * HTTP client for the control server (`services/server`). The media server
 * reserves a runner slot per ingest session (`POST /stream-sessions`), then
 * POSTs each per-window ledger row and springboard event, plus prompts, so the
 * control plane owns sessions/ledger/events and runner slot accounting.
 */
export class ControlClient {
  constructor(private base: string) {}

  /** POST /stream-sessions to create a stream session and reserve a runner slot. */
  async reserveStreamSession(source: string, opts?: { runnerId?: string; sessionId?: string }): Promise<ReservedSession> {
    return this.postJson("/stream-sessions", { source, ...opts });
  }

  /** POST /stream-sessions/:id/end to release the reserved runner slot. */
  async endStreamSession(streamSessionId: string): Promise<unknown> {
    return this.postJson(`/stream-sessions/${streamSessionId}/end`, {});
  }

  /** POST /stream-sessions/:id/windows to persist one token-ledger row. */
  async postWindow(streamSessionId: string, payload: LedgerWindowPayload): Promise<unknown> {
    return this.postJson(`/stream-sessions/${streamSessionId}/windows`, payload);
  }

  /** POST /stream-sessions/:id/events to persist one springboard event. */
  async postEvent(streamSessionId: string, payload: EventPayload): Promise<unknown> {
    return this.postJson(`/stream-sessions/${streamSessionId}/events`, payload);
  }

  /** POST /stream-sessions/:id/prompts to persist a session prompt. */
  async postPrompt(streamSessionId: string, text: string): Promise<unknown> {
    return this.postJson(`/stream-sessions/${streamSessionId}/prompts`, { text });
  }

  private async postJson(path: string, body: unknown): Promise<any> {
    const url = `${this.base.replace(/\/+$/, "")}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await res.text().catch(() => "");
    let parsed: any = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const msg = parsed?.error ? `: ${parsed.error}` : "";
      throw new Error(`control ${url} -> ${res.status}${msg}`);
    }
    return parsed;
  }
}

/**
 * In-memory control client used when the media server runs without a control
 * server (isolated demos / unit tests). It records reservations and posted
 * windows/events so tests can assert the dispatch, but persists nothing.
 */
export class LocalControlClient {
  sessions = new Map<string, ReservedSession>();
  windows: Array<{ sessionId: string; payload: LedgerWindowPayload }> = [];
  events: Array<{ sessionId: string; payload: EventPayload }> = [];
  prompts: Array<{ sessionId: string; text: string }> = [];
  private counter = 0;

  async reserveStreamSession(source: string, opts?: { runnerId?: string }): Promise<ReservedSession> {
    const id = `local-${++this.counter}`;
    const session: ReservedSession = {
      session: { id, status: "active", source },
      runner: {
        id: opts?.runnerId ?? "runner-local",
        name: "runner-local",
        status: "healthy",
        slotsUsed: 1,
        capacity: 3,
      },
    };
    this.sessions.set(id, session);
    return session;
  }

  async endStreamSession(streamSessionId: string): Promise<unknown> {
    const s = this.sessions.get(streamSessionId);
    if (s) s.session.status = "ended";
    return { ok: true };
  }

  async postWindow(streamSessionId: string, payload: LedgerWindowPayload): Promise<unknown> {
    this.windows.push({ sessionId: streamSessionId, payload });
    return { ok: true };
  }

  async postEvent(streamSessionId: string, payload: EventPayload): Promise<unknown> {
    this.events.push({ sessionId: streamSessionId, payload });
    return { ok: true };
  }

  async postPrompt(streamSessionId: string, text: string): Promise<unknown> {
    this.prompts.push({ sessionId: streamSessionId, text });
    return { ok: true };
  }
}
