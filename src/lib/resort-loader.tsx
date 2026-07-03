"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

/**
 * Resort loader for the slope-author editor.
 *
 * Fetches the open-ski-data registry from raw GitHub (no Snowple DB
 * round-trip — the patch flow needs the *registry* shape, not the
 * Snowple DB's denormalized one). Walks the index → country → region
 * tree once on mount to build the slug picker, then exposes a
 * `loadResort(slug)` that fetches the 5 JSON files for one resort.
 *
 * Read-only at this stage. Sub-task 1 of the CRAWL editor: prove
 * loading + rendering works end-to-end before adding edit affordances.
 */

const RAW = "https://raw.githubusercontent.com/powder-nomad/open-ski-data/main";

export type ResortRef = {
  slug: string;
  countryCode: string;
  regionSlug: string;
  /** Display label for the dropdown ("Yongpyong (kr/gangwon)"). */
  label: string;
};

/**
 * Per-record provenance. Mirrors the optional `provenance` block in
 * each entity schema (place / lift / slope / webcam). `source` is the
 * primary classifier; osm_* fields are auxiliary history pointers
 * that survive a user-edit transition.
 */
export type Provenance = {
  source: "osm" | "operator" | "user-edit" | "import";
  osm_way_id?: number;
  osm_node_ids?: number[];
  osm_version?: number;
  contributor?: string;
  source_url?: string;
  /** YYYY-MM-DD */
  last_verified?: string;
};

export type SlopeRecord = {
  id: string;
  name: string;
  name_i18n?: Record<string, string>;
  type?: string;
  difficulty: string | null;
  length_m?: number | null;
  coordinates: { lat: number; lon: number }[];
  connected_slope_ids?: string[];
  connected_lift_ids?: string[];
  /**
   * Slope's traversal through the resort's slope-graph. Each id refs
   * a graph edge in slope-graph.json. When present, this is the
   * canonical geometry (`coordinates` becomes a denormalized cache).
   * Authored via the slope-author "Build path through graph" tool.
   */
  edge_ids?: string[];
  provenance?: Provenance;
};

export type LiftRecord = {
  id: string;
  name: string;
  name_i18n?: Record<string, string>;
  type?: string;
  capacity_per_hour?: number | null;
  length_m?: number | null;
  vertical_m?: number | null;
  coordinates: { lat: number; lon: number; alt_m?: number | null }[];
  provenance?: Provenance;
};

export type WebcamRecord = {
  label: string;
  label_i18n?: Record<string, string>;
  url: string;
  type?: string;
  /**
   * Optional pin locations for map display. Single-camera webcams
   * have one point; composite/multi-feed webcams may have several
   * (e.g. one stream that pans across multiple slopes). Each pin's
   * optional `label` overrides the webcam's parent label for that
   * specific pin's tooltip.
   *
   * Schema went from object → array on 2026-04-26 (commit ca79cd8).
   * The previous object form never shipped to data so there's no
   * back-compat read needed.
   */
  coordinates?: { lat: number; lon: number; label?: string }[];
  provenance?: Provenance;
};

export type PlaceRecord = {
  country_code: string;
  region_slug: string;
  place_slug: string;
  name: string;
  region: string;
  country: string;
  coordinates: { latitude: number; longitude: number };
  elevations?: { base_m?: number; summit_m?: number };
  tags?: string[];
  provenance?: Provenance;
  // Pass-through for fields we don't model yet so the patch round-trips.
  [key: string]: unknown;
};

/**
 * Trail graph (open-ski-data slope-graph schema). Nodes are
 * lat/lng/alt_m points with a kind (summit/base/fork/...). Edges
 * connect two nodes and carry the polyline geometry of a single
 * trail/lift/traverse segment between them. Multiple slopes can
 * share an edge — shared sections fall out of the graph for free.
 *
 * Migrated yongpyong proof commit on open-ski-data: 04aad7b.
 */
export type GraphNodeKind =
  | "summit"
  | "base"
  | "fork"
  | "merge"
  | "lift_top"
  | "lift_bottom"
  | "lift_station"
  | "waypoint";

export type GraphNode = {
  id: string; // n-NNNN
  lat: number;
  lng: number;
  alt_m: number;
  kind?: GraphNodeKind;
};

export type GraphEdgeKind = "slope" | "lift" | "traverse";

export type GraphEdge = {
  id: string; // e-NNNN
  from: string;
  to: string;
  kind: GraphEdgeKind;
  geometry: { lat: number; lng: number; alt_m: number }[];
};

export type SlopeGraphRecord = {
  place_slug: string;
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Optional snap configuration — preserved on round-trip but not modelled here. */
  snap_config?: unknown;
};

export type LoadedResort = {
  ref: ResortRef;
  place: PlaceRecord;
  slopes: SlopeRecord[];
  lifts: LiftRecord[];
  webcams: WebcamRecord[];
  graph: SlopeGraphRecord | null;
};

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/**
 * Walk the registry index → countries → regions to build the flat
 * slug list. Done once on component mount; the result is small (26
 * resorts at the moment) so we hold it in component state.
 */
async function fetchManifest(): Promise<ResortRef[]> {
  type GlobalIndex = { countries: { country_code: string; path: string }[] };
  type CountryIndex = {
    country: { country_code: string; name: string };
    regions: { region_slug: string; name: string; path: string }[];
  };
  type RegionIndex = {
    country: { country_code: string };
    region: { region_slug: string; name: string };
    places: { place_slug: string; path: string }[];
  };

  const global = await fetchJson<GlobalIndex>(`${RAW}/registry/index.json`);
  if (!global) return [];

  const refs: ResortRef[] = [];
  for (const country of global.countries) {
    const countryUrl = `${RAW}/${country.path}`;
    const countryIndex = await fetchJson<CountryIndex>(countryUrl);
    if (!countryIndex) continue;
    for (const region of countryIndex.regions) {
      const regionUrl = `${RAW}/${region.path}`;
      const regionIndex = await fetchJson<RegionIndex>(regionUrl);
      if (!regionIndex) continue;
      for (const place of regionIndex.places) {
        refs.push({
          slug: place.place_slug,
          countryCode: country.country_code,
          regionSlug: region.region_slug,
          label: `${place.place_slug} (${country.country_code}/${region.region_slug})`,
        });
      }
    }
  }
  refs.sort((a, b) => a.label.localeCompare(b.label));
  return refs;
}

async function loadResort(ref: ResortRef): Promise<LoadedResort | null> {
  const base = `${RAW}/registry/${ref.countryCode}/${ref.regionSlug}/${ref.slug}`;
  const place = await fetchJson<PlaceRecord>(`${base}/place.json`);
  if (!place) return null;

  // Sidecars are optional — a resort may not yet have slopes/lifts/
  // webcams authored. Treat 404 as "empty list" so the editor still
  // opens and you can add the first one.
  const slopesDoc = await fetchJson<{ slopes: (SlopeRecord & { id: string | number })[] }>(`${base}/slopes.json`);
  const liftsDoc = await fetchJson<{ lifts: (LiftRecord & { id: string | number })[] }>(`${base}/lifts.json`);
  const webcamsDoc = await fetchJson<{ webcams: WebcamRecord[] }>(`${base}/webcams.json`);
  const graph = await fetchJson<SlopeGraphRecord>(`${base}/slope-graph.json`);

  // Normalize ids to string. open-ski-data's schema allows
  // string|integer; SkiWatch-imported lifts ship numeric ids
  // starting at 0. The editor's React state machinery would
  // otherwise treat 0 as falsy ("no selection") and fail to open
  // the form for the first lift in any SkiWatch resort.
  // Persist back as string on save (CI accepts both).
  const normalizeId = <T extends { id: string | number }>(arr: T[]): (Omit<T, "id"> & { id: string })[] =>
    arr.map((x) => ({ ...x, id: String(x.id) }));

  return {
    ref,
    place,
    slopes: normalizeId(slopesDoc?.slopes ?? []),
    lifts: normalizeId(liftsDoc?.lifts ?? []),
    webcams: webcamsDoc?.webcams ?? [],
    graph,
  };
}

export function ResortLoader({
  onLoad,
}: {
  onLoad: (resort: LoadedResort | null) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const [refs, setRefs] = useState<ResortRef[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchManifest()
      .then((list) => {
        if (cancelled) return;
        setRefs(list);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(`Failed to load resort manifest: ${err.message ?? err}`);
        setRefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handlePick(slug: string) {
    setPicked(slug);
    setError(null);
    if (!slug) {
      onLoad(null);
      return;
    }
    const ref = refs?.find((r) => r.slug === slug);
    if (!ref) return;
    setLoading(true);
    try {
      const resort = await loadResort(ref);
      if (!resort) {
        setError(`No place.json found for ${slug}`);
        onLoad(null);
        return;
      }
      onLoad(resort);
    } catch (err) {
      setError(`Failed to load ${slug}: ${(err as Error).message ?? err}`);
      onLoad(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <label className="mb-1 block text-[11px] font-semibold text-[var(--fg-muted)]">
        {t("editExistingResort")}
      </label>
      {refs === null ? (
        <p className="text-xs text-[var(--fg-muted)]">{t("loadingRegistry")}</p>
      ) : refs.length === 0 ? (
        <p className="text-xs text-[var(--fg-muted)]">
          {t("noResortsFound")} {error}
        </p>
      ) : (
        <select
          value={picked}
          onChange={(e) => handlePick(e.target.value)}
          disabled={loading}
          className="w-full rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 text-sm text-[var(--fg)]"
        >
          <option value="">{t("pickAResortPlaceholder")}</option>
          {refs.map((r) => (
            <option key={r.slug} value={r.slug}>
              {r.label}
            </option>
          ))}
        </select>
      )}
      {loading && (
        <p className="mt-1 text-xs text-[var(--fg-muted)]">{t("fetchingJson")}</p>
      )}
      {error && (
        <p className="mt-1 text-xs text-[#f87171]">{error}</p>
      )}
    </div>
  );
}
