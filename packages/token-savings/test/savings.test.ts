import { describe, expect, it } from 'vitest';
import {
  SILENT_REASON,
  WindowEvent,
  cumulativeSavings,
  liveWindow,
  sessionCounters,
  sparklineSeries,
  whySilent,
  windowSavings,
  windowSavingsPct,
} from '../src/index.js';

/** Build a ledger row with sensible defaults. */
function ev(partial: Partial<WindowEvent>): WindowEvent {
  return {
    seq: 0,
    tStart: 0,
    tEnd: 10000,
    pSpeak: 0.05,
    decision: 'silent',
    tokensVisual: 40,
    tokensBaselineDense: 1000,
    tokensGenerated: 0,
    ...partial,
  };
}

describe('token-savings engine', () => {
  it('reports a silent window as ~0 generated tokens with the gate-silent reason', () => {
    const w = windowSavings(ev({ seq: 3, decision: 'silent', tokensGenerated: 0 }));
    expect(w.tokensGenerated).toBe(0);
    expect(w.decision).toBe('silent');
    expect(w.reason).toBe(SILENT_REASON);
  });

  it('coerces any stray generated tokens on a silent window to 0', () => {
    const w = windowSavings(ev({ decision: 'silent', tokensGenerated: 12 }));
    expect(w.tokensGenerated).toBe(0);
  });

  it('keeps generated tokens when the VLM runs on a speak window', () => {
    const w = windowSavings(ev({ decision: 'speak', pSpeak: 0.9, tokensGenerated: 340 }));
    expect(w.tokensGenerated).toBe(340);
    expect(w.reason).toContain('System 2 invoked');
  });

  it('computes codec savings and savings % per window', () => {
    const w = windowSavings(ev({ tokensVisual: 250, tokensBaselineDense: 1000 }));
    expect(w.tokensSaved).toBe(750);
    expect(w.savingsPct).toBeCloseTo(0.75, 5);
  });

  it('clamps savings fraction to [0,1] and guards a zero dense baseline', () => {
    // visual > dense yields negative savings -> clamped to 0 (no negative savings).
    expect(windowSavingsPct(2000, 1000)).toBe(0);
    expect(windowSavingsPct(100, 0)).toBe(0);
    expect(windowSavingsPct(0, 1000)).toBe(1);
  });

  it('liveWindow reports the most recent window with the silent reason', () => {
    const events = [
      ev({ seq: 0, decision: 'speak', pSpeak: 0.8, tokensGenerated: 200 }),
      ev({ seq: 1, decision: 'silent', pSpeak: 0.04 }),
    ];
    const live = liveWindow(events);
    expect(live.seq).toBe(1);
    expect(live.isSilent).toBe(true);
    expect(live.tokensGenerated).toBe(0);
    expect(live.reason).toBe(SILENT_REASON);
  });

  it('liveWindow returns an empty-state silent window for no events', () => {
    const live = liveWindow([]);
    expect(live.isSilent).toBe(true);
    expect(live.tokensGenerated).toBe(0);
    expect(live.reason).toBe(SILENT_REASON);
  });

  it('cumulative savings % is high on a mostly-static stream', () => {
    // 9 silent windows + 1 speak window -> mostly static.
    const events: WindowEvent[] = [];
    for (let i = 0; i < 9; i++) {
      events.push(ev({ seq: i, decision: 'silent', tokensVisual: 40, tokensBaselineDense: 1000, tokensGenerated: 0 }));
    }
    events.push(ev({ seq: 9, decision: 'speak', tokensVisual: 400, tokensBaselineDense: 1000, tokensGenerated: 350 }));
    const c = cumulativeSavings(events);
    expect(c.windows).toBe(10);
    expect(c.silentWindows).toBe(9);
    expect(c.speakWindows).toBe(1);
    // generated total is dominated by the single speak window.
    expect(c.tokensGeneratedTotal).toBe(350);
    // dense baseline = 10*1000, visual = 9*40 + 400 = 760 -> saved = 9240.
    expect(c.tokensSavedTotal).toBe(9240);
    expect(c.savingsPct).toBeCloseTo(0.924, 3);
  });

  it('p_speak sparkline carries the silent/speak band on every point', () => {
    const events = [
      ev({ seq: 0, tEnd: 10000, pSpeak: 0.1, decision: 'silent' }),
      ev({ seq: 1, tEnd: 20000, pSpeak: 0.85, decision: 'speak' }),
    ];
    const s = sparklineSeries(events);
    expect(s).toHaveLength(2);
    expect(s[0]).toEqual({ t: 10000, pSpeak: 0.1, decision: 'silent' });
    expect(s[1]).toEqual({ t: 20000, pSpeak: 0.85, decision: 'speak' });
  });

  it('separates stream-minutes from tokens-avoided counters', () => {
    const events = [
      ev({ seq: 0, tStart: 0, tEnd: 60000, decision: 'silent', tokensVisual: 0, tokensBaselineDense: 1000 }),
      ev({ seq: 1, tStart: 60000, tEnd: 120000, decision: 'silent', tokensVisual: 0, tokensBaselineDense: 1000 }),
    ];
    const c = sessionCounters(events, 120000);
    expect(c.streamMinutes).toBeCloseTo(2, 6);
    expect(c.tokensAvoided).toBe(2000);
    expect(c.tokensGenerated).toBe(0);
  });

  it('extends the stream-minute counter through the live (open) window', () => {
    const events = [ev({ seq: 0, tStart: 0, tEnd: 60000 })];
    const c = sessionCounters(events, 90000);
    expect(c.streamMinutes).toBeCloseTo(1.5, 6);
  });

  it('an eventful stream shows the VLM firing (speak windows present)', () => {
    const events = [
      ev({ seq: 0, decision: 'silent', pSpeak: 0.05 }),
      ev({ seq: 1, decision: 'speak', pSpeak: 0.9, tokensGenerated: 500 }),
      ev({ seq: 2, decision: 'speak', pSpeak: 0.95, tokensGenerated: 420 }),
    ];
    const c = cumulativeSavings(events);
    expect(c.speakWindows).toBe(2);
    expect(c.tokensGeneratedTotal).toBe(920);
    expect(whySilent(events[1])).toContain('System 2 invoked');
  });
});
