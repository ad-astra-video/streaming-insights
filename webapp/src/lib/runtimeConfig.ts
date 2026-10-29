/**
 * Runtime wiring served by the control server (`GET /api/config`) so the
 * browser learns the PUBLIC media origin it must ingest against. The value
 * comes from the committed compose env (`MEDIA_PUBLIC_BASE_URL`) — baking it
 * into the bundle would tie one image to one box and shipped the
 * docker-internal hostname risk we hit in the earlier deploy.
 *
 * A build-time `VITE_MEDIA_BASE_URL` is still honored as a fallback (dev), and
 * when both are absent we assume the media origin is this page's origin.
 */
export interface RuntimeConfig {
  mediaBaseUrl: string | null;
  controlBaseUrl: string | null;
}

const BUILD_TIME_MEDIA = (import.meta.env.VITE_MEDIA_BASE_URL as string | undefined) ?? null;

export async function loadRuntimeConfig(): Promise<RuntimeConfig> {
  try {
    const res = await fetch("/api/config");
    if (res.ok) {
      const body = (await res.json()) as Partial<RuntimeConfig>;
      return {
        mediaBaseUrl: body.mediaBaseUrl ?? BUILD_TIME_MEDIA,
        controlBaseUrl: body.controlBaseUrl ?? null,
      };
    }
  } catch {
    // fall through to the build-time/same-origin fallback
  }
  return { mediaBaseUrl: BUILD_TIME_MEDIA, controlBaseUrl: null };
}

/** Media origin to ingest against, resolving the same-origin fallback. */
export function resolveMediaBaseUrl(cfg: RuntimeConfig | null): string {
  return cfg?.mediaBaseUrl ?? BUILD_TIME_MEDIA ?? window.location.origin;
}
