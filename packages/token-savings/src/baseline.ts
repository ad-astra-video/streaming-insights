/**
 * Analytic dense-baseline method (Phase 0b decision, ADAAAA-7547).
 *
 * Mage-ViT tokenizes on a fixed 16x16 patch grid (`codec_config =
 * { "patch": 16, "max_pixels": 150000 }`), capping resolution via
 * `max_pixels`. The dense baseline per window is therefore:
 *
 *   tokensBaselineDense(window) = framesInWindow * ceil(h / 16) * ceil(w / 16)
 *
 * No dense model run is required. `framesInWindow = (tEnd - tStart) *
 * effective_fps`, where `effective_fps` is the ACTUAL processed frame rate:
 * for `--video_backend codec` the source's native codec fps; for
 * `--video_backend frames` it is `--cur_fps` (default 2).
 */

/** Mage-ViT patch size (fixed 16x16 grid). */
export const PATCH = 16;

/** Frames processed in a window at a given effective frame rate. */
export function frameCountInWindow(
  tStart: number,
  tEnd: number,
  effectiveFps: number,
): number {
  if (!Number.isFinite(effectiveFps) || effectiveFps <= 0) {
    throw new RangeError(
      `effectiveFps must be a positive number, got ${effectiveFps}`,
    );
  }
  if (tEnd < tStart) {
    throw new RangeError(`tEnd (${tEnd}) must be >= tStart (${tStart})`);
  }
  return (tEnd - tStart) * effectiveFps;
}

/**
 * Analytic dense-baseline token count for one window.
 *
 * @param framesInWindow processed frames in the window (may be fractional).
 * @param height frame height in pixels (post `max_pixels` cap).
 * @param width frame width in pixels (post `max_pixels` cap).
 */
export function denseBaselineTokens(
  framesInWindow: number,
  height: number,
  width: number,
): number {
  if (framesInWindow < 0) {
    throw new RangeError(`framesInWindow must be >= 0, got ${framesInWindow}`);
  }
  if (height <= 0 || width <= 0) {
    throw new RangeError(
      `frame dimensions must be positive, got ${height}x${width}`,
    );
  }
  const patchesPerFrame = Math.ceil(height / PATCH) * Math.ceil(width / PATCH);
  return Math.max(0, Math.round(framesInWindow * patchesPerFrame));
}
