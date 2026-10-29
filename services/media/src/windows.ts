import { EventEmitter } from "node:events";

/** One decoded frame pulled off the WebRTC/WS ingest rail (a JPEG sample). */
export interface IngestFrame {
  seq: number;
  /** Receive wall-clock timestamp (seconds). */
  ts: number;
  jpeg: Buffer;
  latencyMs?: number;
}

/** A codec-segment window: the batch of frames the Mage-VL runner scores as one
 *  streaming window (gate + tokens + text). Matches the Phase 0b telemetry
 *  contract's per-window unit. */
export interface CodecWindow {
  /** Monotonic window index within the session. */
  seq: number;
  /** Window start (seconds). */
  tStart: number;
  /** Window end (seconds). */
  tEnd: number;
  frames: IngestFrame[];
}

export interface WindowAccumulatorOptions {
  /** Number of decoded frames that close one window. `tStart`/`tEnd` are taken
   *  from the first/last frame ts, so a window is the `frames`-sized batch. */
  windowFrames: number;
}

/**
 * Groups decoded frames into dispatching windows. Emits `"window"` (CodecWindow)
 * each time a window closes (at `windowFrames` frames), and `flush()` closes the
 * current partial window (returning those frames at session teardown so the last
 * window is not lost). Windows are the unit the runner scores and the
 * token_ledger/events rows are written per window.
 */
export class WindowAccumulator extends EventEmitter {
  private current: IngestFrame[] = [];
  private seq = 0;

  constructor(private opts: WindowAccumulatorOptions) {
    super();
    if (!Number.isInteger(opts.windowFrames) || opts.windowFrames < 1) {
      throw new Error(`windowFrames must be a positive integer (got ${opts.windowFrames})`);
    }
  }

  addFrame(frame: IngestFrame): void {
    this.current.push(frame);
    if (this.current.length >= this.opts.windowFrames) this.close();
  }

  /** Close the current (possibly partial) window and emit it. No-op when empty. */
  close(): void {
    if (this.current.length === 0) return;
    const frames = this.current;
    const window: CodecWindow = {
      seq: this.seq++,
      tStart: frames[0].ts,
      tEnd: frames[frames.length - 1].ts,
      frames,
    };
    this.current = [];
    this.emit("window", window);
  }

  /** Any buffered frames in the current (incomplete) window; count of open frames. */
  get pending(): number {
    return this.current.length;
  }

  /** Close the current window and flush (session teardown). */
  flush(): void {
    this.close();
  }
}
