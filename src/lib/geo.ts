/**
 * Geographic helpers for the editor.
 *
 * Distance math uses the equirectangular approximation — fast,
 * good to ~0.5% for the snap-radius distances we care about
 * (≤100m), and works in the browser without bringing in a full
 * geodesy library.
 *
 * Coordinates use Google Maps' `{lat, lng}` shape internally.
 * Registry JSON stores slope vertices as `{lat, lon}` (OSM heritage);
 * use `fromOsmCoord` to adapt before passing in.
 */

export type LatLng = { lat: number; lng: number };

/** ~1 meter per 0.0000089 degrees of latitude (constant). */
const METERS_PER_DEGREE_LAT = 111_000;

/**
 * Equirectangular distance in meters between two points. Accurate to
 * <1% for distances <1km, which covers every editor-side snap and
 * dedup use case.
 */
export function distanceM(a: LatLng, b: LatLng): number {
  const meanLatRad = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dLat = (a.lat - b.lat) * METERS_PER_DEGREE_LAT;
  const dLng = (a.lng - b.lng) * METERS_PER_DEGREE_LAT * Math.cos(meanLatRad);
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

/** Adapter for registry coordinates ({lat, lon}) → Google Maps shape. */
export function fromOsmCoord(p: { lat: number; lon: number }): LatLng {
  return { lat: p.lat, lng: p.lon };
}

/**
 * Find the candidate closest to `point` within `radiusM`. Returns
 * `null` when no candidate is close enough — the caller decides
 * whether to fall back to the raw point or refuse the action.
 *
 * Linear scan — fine for the few hundred nodes a resort ever has.
 * If the candidate set grows past a few thousand, swap in a spatial
 * index (R-tree / grid).
 */
export function snapToNearest<T extends LatLng>(
  point: LatLng,
  candidates: readonly T[],
  radiusM: number,
): { target: T; distanceM: number } | null {
  let best: { target: T; distanceM: number } | null = null;
  for (const c of candidates) {
    const d = distanceM(point, c);
    if (d > radiusM) continue;
    if (!best || d < best.distanceM) {
      best = { target: c, distanceM: d };
    }
  }
  return best;
}
