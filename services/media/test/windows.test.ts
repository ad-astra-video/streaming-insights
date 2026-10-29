import { describe, expect, it } from "vitest";
import { WindowAccumulator, type CodecWindow } from "../src/windows";

function frame(seq: number, ts: number, size = 100): { seq: number; ts: number; jpeg: Buffer } {
  return { seq, ts, jpeg: Buffer.alloc(size) };
}

function drain(acc: WindowAccumulator): CodecWindow[] {
  const out: CodecWindow[] = [];
  acc.on("window", (w: CodecWindow) => out.push(w));
  return out;
}

describe("WindowAccumulator", () => {
  it("closes a window every `windowFrames` frames with first/last ts", () => {
    const acc = new WindowAccumulator({ windowFrames: 2 });
    const windows = drain(acc);
    acc.addFrame(frame(0, 1.0));
    acc.addFrame(frame(1, 1.5));
    acc.addFrame(frame(2, 2.0));
    acc.addFrame(frame(3, 2.5));
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({ seq: 0, tStart: 1.0, tEnd: 1.5 });
    expect(windows[0].frames).toHaveLength(2);
    expect(windows[1]).toMatchObject({ seq: 1, tStart: 2.0, tEnd: 2.5 });
  });

  it("emits sequential window seq numbers", () => {
    const acc = new WindowAccumulator({ windowFrames: 1 });
    const windows = drain(acc);
    acc.addFrame(frame(0, 0));
    acc.addFrame(frame(1, 1));
    expect(windows.map((w) => w.seq)).toEqual([0, 1]);
  });

  it("flush() closes the current partial window so the last frames are not lost", () => {
    const acc = new WindowAccumulator({ windowFrames: 5 });
    const windows = drain(acc);
    acc.addFrame(frame(0, 1.0));
    acc.addFrame(frame(1, 1.4));
    expect(acc.pending).toBe(2);
    acc.flush();
    expect(acc.pending).toBe(0);
    expect(windows).toHaveLength(1);
    expect(windows[0].frames).toHaveLength(2);
    expect(windows[0].tEnd).toBe(1.4);
  });

  it("flush() on an empty accumulator emits nothing", () => {
    const acc = new WindowAccumulator({ windowFrames: 2 });
    const windows = drain(acc);
    acc.flush();
    expect(windows).toHaveLength(0);
  });

  it("rejects a non-positive windowFrames", () => {
    expect(() => new WindowAccumulator({ windowFrames: 0 })).toThrow();
  });
});
