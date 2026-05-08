/**
 * Public runtime config for the client.
 *
 * Only `NEXT_PUBLIC_*` env vars end up here — anything sensitive
 * (OAuth secrets, server-side elevation key, session HMAC) lives
 * exclusively in route handlers. Mirrors the shape that the ported
 * editor's existing `import { webRuntimeConfig } from
 * "@/lib/runtime-config"` expects.
 */

export const webRuntimeConfig = {
  googleMapsApiKey: process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "",
  googleMapsMapId: process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID ?? "",
} as const;

export type WebRuntimeConfig = typeof webRuntimeConfig;
