/**
 * Shared constants for the streaming-insights control plane.
 *
 * `RUNNERS` / `STREAMS_PER_RUNNER` / `MAX_STREAMS` are first-class capacity
 * constants (mirrors highlights.live). The board target: 1 runner per 5090 on
 * the .151 box (3 runners), 3 streams per runner => 9 concurrent streams.
 */
export const RUNNERS = 3;
export const STREAMS_PER_RUNNER = 3;
export const MAX_STREAMS = RUNNERS * STREAMS_PER_RUNNER;

/** Capacity refusals mirror highlights.live's "no capacity available for runner". */
export const CAPACITY_REFUSED = 503;

/** Default service ports (proposed in the parent plan). */
export const CONTROL_PORT = 3100;
export const MEDIA_PORT = 4070;

/** Public API prefix for the control server. */
export const API_PREFIX = "/api";
