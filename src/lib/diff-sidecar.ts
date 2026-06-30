/**
 * Pure diff functions over slopes, lifts, webcams, and place.json.
 *
 * Parallel to diff-graph.ts but covers the non-graph sidecar files.
 * Called client-side after fetching both blobs from raw.githubusercontent.com.
 */

import type {
  SlopeRecord,
  LiftRecord,
  WebcamRecord,
  PlaceRecord,
} from "./resort-loader";

export type DiffKind = "added" | "removed" | "modified";

export type SlopeDiff = {
  kind: DiffKind;
  id: string;
  before?: SlopeRecord;
  after?: SlopeRecord;
  geometryChanged: boolean;
};

export type LiftDiff = {
  kind: DiffKind;
  id: string;
  before?: LiftRecord;
  after?: LiftRecord;
  geometryChanged: boolean;
};

export type WebcamDiff = {
  kind: DiffKind;
  label: string;
  before?: WebcamRecord;
  after?: WebcamRecord;
};

export type PlaceDiff = {
  hasChanges: boolean;
  before?: PlaceRecord;
  after?: PlaceRecord;
  /** Top-level field names that changed. */
  changedFields: string[];
};

export type SidecarDiff = {
  slopes: SlopeDiff[];
  lifts: LiftDiff[];
  webcams: WebcamDiff[];
  place: PlaceDiff;
};

function coordsChanged(
  a: { lat: number; lon: number }[],
  b: { lat: number; lon: number }[],
): boolean {
  if (a.length !== b.length) return true;
  return a.some((p, i) => p.lat !== b[i].lat || p.lon !== b[i].lon);
}

export function diffSidecar(
  base: {
    slopes: SlopeRecord[];
    lifts: LiftRecord[];
    webcams: WebcamRecord[];
    place: PlaceRecord | null;
  } | null,
  head: {
    slopes: SlopeRecord[];
    lifts: LiftRecord[];
    webcams: WebcamRecord[];
    place: PlaceRecord | null;
  } | null,
): SidecarDiff {
  const baseSlopes = new Map<string, SlopeRecord>(
    (base?.slopes ?? []).map((s) => [s.id, s]),
  );
  const headSlopes = new Map<string, SlopeRecord>(
    (head?.slopes ?? []).map((s) => [s.id, s]),
  );

  const slopes: SlopeDiff[] = [];
  for (const [id, s] of baseSlopes) {
    if (!headSlopes.has(id)) {
      slopes.push({ kind: "removed", id, before: s, geometryChanged: false });
    } else {
      const h = headSlopes.get(id)!;
      const geomChanged = coordsChanged(s.coordinates, h.coordinates);
      if (JSON.stringify(s) !== JSON.stringify(h)) {
        slopes.push({ kind: "modified", id, before: s, after: h, geometryChanged: geomChanged });
      }
    }
  }
  for (const [id, s] of headSlopes) {
    if (!baseSlopes.has(id)) {
      slopes.push({ kind: "added", id, after: s, geometryChanged: false });
    }
  }

  const baseLifts = new Map<string, LiftRecord>(
    (base?.lifts ?? []).map((l) => [l.id, l]),
  );
  const headLifts = new Map<string, LiftRecord>(
    (head?.lifts ?? []).map((l) => [l.id, l]),
  );

  const lifts: LiftDiff[] = [];
  for (const [id, l] of baseLifts) {
    if (!headLifts.has(id)) {
      lifts.push({ kind: "removed", id, before: l, geometryChanged: false });
    } else {
      const h = headLifts.get(id)!;
      const coords = l.coordinates.map((c) => ({ lat: c.lat, lon: c.lon }));
      const hcoords = h.coordinates.map((c) => ({ lat: c.lat, lon: c.lon }));
      const geomChanged = coordsChanged(coords, hcoords);
      if (JSON.stringify(l) !== JSON.stringify(h)) {
        lifts.push({ kind: "modified", id, before: l, after: h, geometryChanged: geomChanged });
      }
    }
  }
  for (const [id, l] of headLifts) {
    if (!baseLifts.has(id)) {
      lifts.push({ kind: "added", id, after: l, geometryChanged: false });
    }
  }

  // Webcams: key by label (no stable numeric id in schema)
  const baseWebcams = new Map<string, WebcamRecord>(
    (base?.webcams ?? []).map((w) => [w.label, w]),
  );
  const headWebcams = new Map<string, WebcamRecord>(
    (head?.webcams ?? []).map((w) => [w.label, w]),
  );

  const webcams: WebcamDiff[] = [];
  for (const [label, w] of baseWebcams) {
    if (!headWebcams.has(label)) {
      webcams.push({ kind: "removed", label, before: w });
    } else {
      const h = headWebcams.get(label)!;
      if (JSON.stringify(w) !== JSON.stringify(h)) {
        webcams.push({ kind: "modified", label, before: w, after: h });
      }
    }
  }
  for (const [label, w] of headWebcams) {
    if (!baseWebcams.has(label)) {
      webcams.push({ kind: "added", label, after: w });
    }
  }

  // Place: field-level diff
  const bp = base?.place ?? null;
  const hp = head?.place ?? null;
  const changedFields: string[] = [];
  if (bp && hp) {
    const allKeys = new Set([...Object.keys(bp), ...Object.keys(hp)]);
    for (const k of allKeys) {
      if (JSON.stringify((bp as Record<string, unknown>)[k]) !== JSON.stringify((hp as Record<string, unknown>)[k])) {
        changedFields.push(k);
      }
    }
  }

  return {
    slopes,
    lifts,
    webcams,
    place: {
      hasChanges: changedFields.length > 0 || (!!bp !== !!hp),
      before: bp ?? undefined,
      after: hp ?? undefined,
      changedFields,
    },
  };
}
