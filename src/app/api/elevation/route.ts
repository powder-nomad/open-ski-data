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

/** Most points one batch may ask for; Google's own limit is 512 per request. */
const BATCH_MAX = 400;

/**
 * Many points at once, for refilling a whole graph's altitudes:
 * `POST { "points": [[lat, lng], ...] }` → `{ "elevations": [m, ...] }`
 * in the same order.
 */
export async function POST(request: Request) {
  let points: unknown;
  try {
    points = ((await request.json()) as { points?: unknown }).points;
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const valid =
    Array.isArray(points) &&
    points.length > 0 &&
    points.length <= BATCH_MAX &&
    points.every(
      (p) =>
        Array.isArray(p) && p.length === 2 &&
        typeof p[0] === "number" && Math.abs(p[0]) <= 90 &&
        typeof p[1] === "number" && Math.abs(p[1]) <= 180,
    );
  if (!valid) {
    return NextResponse.json({ error: `points must be 1-${BATCH_MAX} [lat, lng] pairs` }, { status: 400 });
  }
  const apiKey = process.env.GOOGLE_ELEVATION_API_KEY || process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "GOOGLE_ELEVATION_API_KEY not configured" }, { status: 503 });
  }
  const list = points as [number, number][];
  const elevations: number[] = [];
  // 100 per upstream call keeps the URL well under its length limit.
  for (let at = 0; at < list.length; at += 100) {
    const proxyUrl = new URL(ELEVATION_ENDPOINT);
    proxyUrl.searchParams.set("locations", list.slice(at, at + 100).map(([lat, lng]) => `${lat.toFixed(6)},${lng.toFixed(6)}`).join("|"));
    proxyUrl.searchParams.set("key", apiKey);
    let body: { status: string; results?: { elevation: number }[] };
    try {
      const upstream = await fetch(proxyUrl.toString(), { cache: "no-store" });
      if (!upstream.ok) return NextResponse.json({ error: `elevation upstream HTTP ${upstream.status}` }, { status: 502 });
      body = await upstream.json();
    } catch (err) {
      return NextResponse.json({ error: "elevation upstream unreachable", detail: String(err) }, { status: 502 });
    }
    if (body.status !== "OK" || !body.results) {
      return NextResponse.json({ error: `elevation upstream status=${body.status}` }, { status: 502 });
    }
    for (const r of body.results) elevations.push(Math.round(r.elevation * 10) / 10);
  }
  return NextResponse.json({ elevations, source: "google" });
}
