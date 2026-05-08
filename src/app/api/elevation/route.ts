import { NextResponse } from "next/server";

/**
 * GET /api/elevation?lat=<lat>&lng=<lng>
 *
 * Server-side proxy to the Google Maps Elevation API. Edge-runtime
 * port of the ski-platform `/api/dev/elevation` route — keeps the
 * elevation API key off the client bundle. The same Google Cloud
 * project's Maps key works as a fallback if a dedicated elevation
 * key isn't provisioned.
 *
 * Response shape (matches the editor's existing client-side type):
 *
 *   { lat: number, lng: number, elevation_m: number, source: "google" }
 *
 * On any upstream / config error, returns `{ error: string }` with a
 * status code that indicates whether it's a config problem (503)
 * or an upstream issue (502).
 */

export const runtime = "edge";

const ELEVATION_ENDPOINT =
  "https://maps.googleapis.com/maps/api/elevation/json";

function parseCoord(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const lat = parseCoord(url.searchParams.get("lat"), -90, 90);
  const lng = parseCoord(url.searchParams.get("lng"), -180, 180);

  if (lat == null || lng == null) {
    return NextResponse.json(
      {
        error:
          "lat/lng query params required; lat in [-90,90], lng in [-180,180]",
      },
      { status: 400 },
    );
  }

  const apiKey =
    process.env.GOOGLE_ELEVATION_API_KEY ||
    process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "GOOGLE_ELEVATION_API_KEY not configured" },
      { status: 503 },
    );
  }

  const proxyUrl = new URL(ELEVATION_ENDPOINT);
  proxyUrl.searchParams.set("locations", `${lat},${lng}`);
  proxyUrl.searchParams.set("key", apiKey);

  let upstream: Response;
  try {
    upstream = await fetch(proxyUrl.toString(), { cache: "no-store" });
  } catch (err) {
    return NextResponse.json(
      { error: "elevation upstream unreachable", detail: String(err) },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    return NextResponse.json(
      { error: `elevation upstream HTTP ${upstream.status}` },
      { status: 502 },
    );
  }

  type ElevationResponse = {
    status: string;
    error_message?: string;
    results?: Array<{
      elevation: number;
      location: { lat: number; lng: number };
    }>;
  };

  let body: ElevationResponse;
  try {
    body = (await upstream.json()) as ElevationResponse;
  } catch (err) {
    return NextResponse.json(
      { error: "elevation upstream sent non-JSON", detail: String(err) },
      { status: 502 },
    );
  }

  if (body.status !== "OK" || !body.results?.length) {
    return NextResponse.json(
      {
        error: `elevation upstream status=${body.status}`,
        detail: body.error_message ?? null,
      },
      { status: 502 },
    );
  }

  const result = body.results[0];
  return NextResponse.json({
    lat: result.location.lat,
    lng: result.location.lng,
    elevation_m: Math.round(result.elevation * 10) / 10,
    source: "google",
  });
}
