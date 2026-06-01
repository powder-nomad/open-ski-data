"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";
import { webRuntimeConfig } from "@/lib/runtime-config";
import {
  ResortLoader,
  type LoadedResort,
  type SlopeRecord,
  type LiftRecord,
  type PlaceRecord,
  type Provenance,
  type GraphNode,
  type GraphEdge,
  type SlopeGraphRecord,
} from "@/lib/resort-loader";
import { PatchSaver, type PatchBundle } from "@/lib/ci-status";
import { useSession } from "@/lib/use-session";
import { contribute } from "@/lib/github-client";
import {
  distanceM,
  fromOsmCoord,
  snapToNearest,
  type LatLng,
} from "@/lib/geo";
import { type EditorMode, ModeToolbar, modeDescriptor, MODE_I18N } from "./mode-toolbar";

/**
 * Slope Author v2 — see ./page.tsx for the rationale.
 *
 * State organisation:
 *   - `mode` — single source of truth for "what does a click do"
 *   - `loadedResort` — current resort baseline from open-ski-data
 *   - `selectedSlopeId` — slope under the editor
 *   - `slopeOverrides` — per-slope partial diffs (coordinates +
 *     metadata edits); merged onto the baseline at save time
 *
 * Map interaction is split per-mode in `handleMapClick`. The
 * "edit-slope-geom" mode swaps the selected slope's polyline for an
 * editable Google Maps polyline (`editable: true`) which gives drag,
 * insert (mid-segment double-click), and delete (right-click vertex)
 * for free; we listen on path mutations to mirror them into
 * `slopeOverrides[id].coordinates`.
 *
 * Out of scope for this scaffold (will land in follow-up commits):
 *   - Draw new slope / lift
 *   - Lift geometry editing
 *   - Graph node editing (incl. POI types)
 *   - Edge connect / edit
 *   - Webcam editing
 *   - Place editing
 */

const KOREA_CENTER = { lat: 37.5, lng: 128.0 };
const DEFAULT_ZOOM = 8;

const SLOPE_BASELINE_COLOR = "#94a3b8"; // slate-400 — read-only baseline
const SLOPE_SELECTED_COLOR = "#f59e0b"; // amber-500 — selected
const SLOPE_EDIT_COLOR = "#22d3ee"; // cyan-400 — actively editable

const LIFT_BASELINE_COLOR = "#fb7185"; // rose-400 — distinguishable from slopes
const LIFT_SELECTED_COLOR = "#f59e0b"; // amber-500 — same selected hue as slopes
const LIFT_EDIT_COLOR = "#22d3ee";

// Radius for "snap to existing node" decisions. Matches the OSM
// import dedup tolerance so a vertex authored in the editor near an
// imported endpoint resolves to the same point both ways.
const SNAP_RADIUS_M = 10;
// connect-nodes click radius. Larger than SNAP_RADIUS_M because here
// the user is deliberately picking a target — they want forgiving
// hit-testing, not strict dedup-radius. 25m is roughly a marker's
// scale-7 footprint at typical resort zoom (16–17).
const CONNECT_PICK_RADIUS_M = 25;

// Curated set of lift type values seen across open-ski-data. Free
// text still passes the schema; the dropdown helps land on a
// canonical value instead of inventing a new one.
const LIFT_TYPE_OPTIONS = [
  "chair_lift",
  "gondola",
  "cable_car",
  "magic_carpet",
  "station",
] as const;

// Locales surfaced in every i18n editor. Korean first since this is
// a Korean-first project; English second for cross-region readers;
// Japanese third because it shares katakana imports for ski terms.
// Adding a fourth locale is a one-line change; the UI just renders
// whatever this list contains.
const I18N_LOCALES = ["ko", "en", "ja"] as const;
type I18nLocale = (typeof I18N_LOCALES)[number];

let mapsConfigured = false;

type PickedPoint = {
  id: string;
  lat: number;
  lng: number;
  elevation_m: number | null;
  elevation_error: string | null;
};

type SlopeOverride = Partial<SlopeRecord>;
type LiftOverride = Partial<LiftRecord>;

export function SlopeAuthor2() {
  const t = useTranslations("slopeAuthor");
  const locale = useLocale();
  // Session at the top so patchBundle can stamp `provenance.contributor`
  // with the signed-in GitHub login. NewPlaceForm calls useSession()
  // independently lower down — both calls run their own fetch on
  // mount; the cost is negligible and avoids prop-threading.
  const { user: sessionUser } = useSession();
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMap = useRef<google.maps.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  // Mobile drawer state — desktop ignores this (aside is a fixed
  // right column at md+). Three snap states cycled by the handle:
  //   peek (~3.5rem), half (50dvh, default), full (80dvh).
  // Declared here (not near the return) so the map-resize useEffect
  // below can reference it without a TDZ.
  const [drawerState, setDrawerState] = useState<"peek" | "half" | "full">(
    "half",
  );

  const [mode, setMode] = useState<EditorMode>("select");
  const modeRef = useRef<EditorMode>(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  // Pick mode state: dropped pins + their elevation. Bare-minimum;
  // a fuller v2 brings a list panel like v1's, but the marker-on-map
  // proves the pattern.
  const [picks, setPicks] = useState<PickedPoint[]>([]);
  const pickMarkersRef = useRef<google.maps.Marker[]>([]);

  const [loadedResort, setLoadedResort] = useState<LoadedResort | null>(null);
  // Mirror of loadedResort that the (stable-identity) map click
  // callback can read without being re-created on every resort load.
  // Same pattern as modeRef above.
  const loadedResortRef = useRef<LoadedResort | null>(null);
  useEffect(() => {
    loadedResortRef.current = loadedResort;
  }, [loadedResort]);

  // Stable refs for connect-nodes state so the (deps:[]) map-click
  // callback can read the latest values without being re-created.
  const addedGraphNodesRef = useRef<GraphNode[]>([]);
  const addedGraphEdgesRef = useRef<GraphEdge[]>([]);
  const anchorNodeIdRef = useRef<string | null>(null);
  const pickConnectNodeRef = useRef<(nodeId: string) => void>(() => {});
  useEffect(() => {
    addedGraphNodesRef.current = addedGraphNodes;
  });
  useEffect(() => {
    addedGraphEdgesRef.current = addedGraphEdges;
  });
  useEffect(() => {
    anchorNodeIdRef.current = anchorNodeId;
  });

  // Chain mode: after the first node picks the anchor, every subsequent
  // click creates an edge anchor→clicked AND advances the anchor to the
  // clicked node so the next click continues the chain (1 click per edge
  // after the first). Click the same anchor again to detach; Esc also
  // detaches. Disconnected edges = Esc + new chain.
  const pickConnectNode = useCallback((nodeId: string) => {
    const prevAnchor = anchorNodeIdRef.current;
    if (!prevAnchor) {
      setAnchorNodeId(nodeId);
      return;
    }
    if (prevAnchor === nodeId) {
      // Clicking the anchor again detaches.
      setAnchorNodeId(null);
      return;
    }
    const resort = loadedResortRef.current;
    if (!resort?.graph) {
      setAnchorNodeId(null);
      return;
    }
    const allNodes = [
      ...resort.graph.nodes,
      ...addedGraphNodesRef.current,
    ];
    const fromN = allNodes.find((n) => n.id === prevAnchor);
    const toN = allNodes.find((n) => n.id === nodeId);
    if (!fromN || !toN) {
      setAnchorNodeId(null);
      return;
    }
    // Dedup undirected: skip if any edge already connects this pair.
    // Catches both "click A→B again" and "click B→A after A→B".
    const existingEdges = [
      ...(resort.graph.edges ?? []),
      ...addedGraphEdgesRef.current,
    ];
    const dup = existingEdges.some(
      (e) =>
        (e.from === fromN.id && e.to === toN.id) ||
        (e.from === toN.id && e.to === fromN.id),
    );
    if (!dup) {
      const id = `e-u-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      setAddedGraphEdges((prev) => [
        ...prev,
        {
          id,
          from: fromN.id,
          to: toN.id,
          kind: "traverse",
          geometry: [
            { lat: fromN.lat, lng: fromN.lng, alt_m: fromN.alt_m },
            { lat: toN.lat, lng: toN.lng, alt_m: toN.alt_m },
          ],
        },
      ]);
    }
    // Chain: advance the anchor to the just-clicked node. The dup-check
    // above still ran with the previous anchor, so even when the edge
    // wasn't created (dedup hit), advancing the anchor is the right
    // move — user wanted to continue from there.
    setAnchorNodeId(nodeId);
  }, []);
  useEffect(() => {
    pickConnectNodeRef.current = pickConnectNode;
  }, [pickConnectNode]);

  // Slope state. `selectedSlopeId` drives both the right-rail editor
  // form and which polyline takes the "editable" treatment when the
  // mode flips to `edit-slope-geom`.
  const [selectedSlopeId, setSelectedSlopeId] = useState<string | null>(null);
  const [slopeOverrides, setSlopeOverrides] = useState<
    Record<string, SlopeOverride>
  >({});

  // Lift state — same shape as slope state. Selection is mutually
  // exclusive with slope selection so the right-rail meta panel only
  // ever shows one entity at a time.
  const [selectedLiftId, setSelectedLiftId] = useState<string | null>(null);
  const [liftOverrides, setLiftOverrides] = useState<
    Record<string, LiftOverride>
  >({});

  // Place metadata override — only one place per resort, so a single
  // partial diff. Wiped on resort change.
  const [placeOverride, setPlaceOverride] = useState<Partial<PlaceRecord>>({});

  // Newly-drawn slopes (draw-slope mode). Each gets a fresh id +
  // name when finalized; the patch bundle appends them to slopes.json
  // alongside any edited baseline rows. Wiped on resort change.
  const [addedSlopes, setAddedSlopes] = useState<SlopeRecord[]>([]);
  const [addedLifts, setAddedLifts] = useState<LiftRecord[]>([]);

  // Deleted baseline ids — entities the user wants dropped from the
  // patch bundle. Editor filters them out of the map + list so they
  // vanish visually; patchBundle omits them from slopes.json /
  // lifts.json so the PR diff shows the removal. Added-this-session
  // entities are not tracked here — they're removed directly from
  // addedSlopes / addedLifts.
  const [deletedSlopeIds, setDeletedSlopeIds] = useState<string[]>([]);
  const [deletedLiftIds, setDeletedLiftIds] = useState<string[]>([]);

  // Newly-dropped graph nodes (add-node mode). Each carries a fresh
  // schema-valid id (n-u-<base36>) and starts at alt_m=0 — the
  // elevation lookup fills it in async via /api/elevation. Wiped on
  // resort change. The patch bundle merges these onto the existing
  // graph's nodes[] (the editor will not emit slope-graph.json unless
  // an existing graph is present, since the schema requires edges).
  const [addedGraphNodes, setAddedGraphNodes] = useState<GraphNode[]>([]);
  // Session-added edges (connect-nodes mode). Each edge connects two
  // existing or session-added nodes by id with a straight 2-point
  // geometry. Emitted into slope-graph.json alongside addedGraphNodes.
  const [addedGraphEdges, setAddedGraphEdges] = useState<GraphEdge[]>([]);
  // Chain anchor for connect-nodes mode. null = no chain in progress;
  // non-null = next click will create an edge anchor→clicked and the
  // anchor advances to the clicked node. Cleared on Esc, resort change,
  // mode change away from connect-nodes, and on anchor self-click.
  const [anchorNodeId, setAnchorNodeId] = useState<string | null>(null);

  // OSM Overpass re-import status. Same flow as v1: pull
  // piste:type=downhill ways within 5km of the resort centre, drop
  // the ones whose endpoints match an existing slope (≤10m), append
  // the rest to addedSlopes for review.
  const [osmImport, setOsmImport] = useState<
    | { kind: "idle" }
    | { kind: "fetching" }
    | { kind: "done"; added: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  // Live in-progress drawing for slopes (mode === "draw-slope") +
  // lifts (mode === "draw-lift"). Same shape; the rendering effect
  // dispatches by mode.
  const [drawSlopePoints, setDrawSlopePoints] = useState<
    { lat: number; lng: number }[]
  >([]);
  const [drawLiftPoints, setDrawLiftPoints] = useState<
    { lat: number; lng: number }[]
  >([]);
  const drawSlopeLineRef = useRef<google.maps.Polyline | null>(null);
  const drawSlopeMarkersRef = useRef<google.maps.Marker[]>([]);
  const drawLiftLineRef = useRef<google.maps.Polyline | null>(null);
  const drawLiftMarkersRef = useRef<google.maps.Marker[]>([]);
  // Markers for the resort's graph nodes (existing + this-session
  // additions). Re-rendered by the effect below whenever the
  // underlying lists change. Existing nodes use a dim slate color so
  // they read as "snap targets" without competing with slope colors;
  // added nodes pop in emerald to make new authoring visible.
  const graphNodeMarkersRef = useRef<google.maps.Marker[]>([]);
  // Pending finalize forms.
  const [pendingDrawSlope, setPendingDrawSlope] = useState<
    { points: { lat: number; lng: number }[] } | null
  >(null);
  const [pendingDrawLift, setPendingDrawLift] = useState<
    { points: { lat: number; lng: number }[] } | null
  >(null);

  // Polylines for every slope/lift on the loaded resort. Keyed by id
  // so we can swap one out for an editable variant when the mode
  // flips to edit-*-geom without rebuilding the rest of the map.
  const slopeLineRefs = useRef<Map<string, google.maps.Polyline>>(new Map());
  const liftLineRefs = useRef<Map<string, google.maps.Polyline>>(new Map());

  // Selection state cleared when the resort changes.
  useEffect(() => {
    setSelectedSlopeId(null);
    setSelectedLiftId(null);
    setSlopeOverrides({});
    setLiftOverrides({});
    setPlaceOverride({});
    setAddedSlopes([]);
    setAddedLifts([]);
    setAddedGraphNodes([]);
    setAddedGraphEdges([]);
    setAnchorNodeId(null);
    setDeletedSlopeIds([]);
    setDeletedLiftIds([]);
    setDrawSlopePoints([]);
    setDrawLiftPoints([]);
    setPendingDrawSlope(null);
    setPendingDrawLift(null);
    setPicks([]);
  }, [loadedResort?.ref.slug]);

  // Selecting a slope clears the lift selection and vice-versa —
  // the right-rail meta panel only renders one entity at a time.
  function selectSlope(id: string | null) {
    setSelectedSlopeId(id);
    if (id) setSelectedLiftId(null);
  }
  function selectLift(id: string | null) {
    setSelectedLiftId(id);
    if (id) setSelectedSlopeId(null);
  }

  // Delete a slope. If it's an added-this-session record, drop it
  // straight from addedSlopes (no need to tombstone). Otherwise mark
  // the baseline id as deleted so patchBundle omits it from the
  // emitted slopes.json. Either way, any pending override on that
  // record is also dropped — keeping it around would inflate the
  // edit counter for an entity that won't ship.
  function deleteSlope(id: string) {
    if (addedSlopes.some((s) => s.id === id)) {
      setAddedSlopes((prev) => prev.filter((s) => s.id !== id));
    } else {
      setDeletedSlopeIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
    setSlopeOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedSlopeId === id) setSelectedSlopeId(null);
  }
  function deleteLift(id: string) {
    if (addedLifts.some((l) => l.id === id)) {
      setAddedLifts((prev) => prev.filter((l) => l.id !== id));
    } else {
      setDeletedLiftIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
    }
    setLiftOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
    if (selectedLiftId === id) setSelectedLiftId(null);
  }

  // ── Map bootstrap ──────────────────────────────────────────────

  useEffect(() => {
    if (!mapRef.current || googleMap.current) return;
    let cancelled = false;
    async function init() {
      try {
        if (!mapsConfigured) {
          setOptions({ key: webRuntimeConfig.mapApiKey, v: "weekly" });
          mapsConfigured = true;
        }
        const { Map } = (await importLibrary("maps")) as google.maps.MapsLibrary;
        await importLibrary("marker"); // pre-warm AdvancedMarkerElement
        if (cancelled || !mapRef.current) return;
        const map = new Map(mapRef.current, {
          center: KOREA_CENTER,
          zoom: DEFAULT_ZOOM,
          mapTypeId: "terrain",
          clickableIcons: false,
        });
        googleMap.current = map;
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (!e.latLng) return;
          handleMapClick({ lat: e.latLng.lat(), lng: e.latLng.lng() });
        });
        setMapReady(true);
      } catch (err) {
        setMapError(err instanceof Error ? err.message : String(err));
      }
    }
    init();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-tile the map whenever the drawer changes height (or when the
  // map first becomes ready). Google Maps caches container dimensions
  // at init time and after layout reflows; without an explicit
  // `resize` event the tiles stay sized to the old viewport, leaving
  // big empty bands when the drawer transitions on mobile.
  // 250ms matches the drawer's `transition-[max-height] duration-200`
  // so we measure post-transition.
  useEffect(() => {
    if (!mapReady) return;
    const map = googleMap.current;
    if (!map) return;
    const t = setTimeout(() => {
      google.maps.event.trigger(map, "resize");
    }, 250);
    return () => clearTimeout(t);
  }, [drawerState, mapReady]);

  // ── Map click handler — dispatches by current mode ────────────

  const handleMapClick = useCallback(async (latLng: { lat: number; lng: number }) => {
    const m = modeRef.current;
    if (m === "pick") {
      const id = `pick-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const draft: PickedPoint = {
        id,
        lat: latLng.lat,
        lng: latLng.lng,
        elevation_m: null,
        elevation_error: null,
      };
      setPicks((prev) => [...prev, draft]);
      try {
        const res = await fetch(
          `/api/elevation?lat=${latLng.lat}&lng=${latLng.lng}`,
          { cache: "no-store" },
        );
        if (res.ok) {
          const body = (await res.json()) as { elevation_m?: number };
          if (typeof body.elevation_m === "number") {
            setPicks((prev) =>
              prev.map((p) =>
                p.id === id ? { ...p, elevation_m: body.elevation_m! } : p,
              ),
            );
          }
        } else {
          setPicks((prev) =>
            prev.map((p) =>
              p.id === id ? { ...p, elevation_error: `HTTP ${res.status}` } : p,
            ),
          );
        }
      } catch (err) {
        setPicks((prev) =>
          prev.map((p) =>
            p.id === id
              ? { ...p, elevation_error: err instanceof Error ? err.message : String(err) }
              : p,
          ),
        );
      }
    }
    // `select` mode handles selection via per-polyline click listeners
    // (set up below in the slope/lift render effects), not via the
    // map background click. Background clicks in select mode just
    // clear the current selection.
    if (m === "select") {
      setSelectedSlopeId(null);
      setSelectedLiftId(null);
    }
    // Snap-on-create: a freshly-dropped vertex within SNAP_RADIUS_M
    // of an existing graph node, an existing slope/lift vertex, or
    // an already-placed vertex in the same draw session resolves to
    // the existing point instead of creating a near-duplicate. The
    // same data ends up in `edge_ids`-friendly form when the graph
    // editor lands, and users authoring against an OSM-imported
    // baseline don't fight pixel-level precision.
    const snapVertex = (p: LatLng, candidates: LatLng[]): LatLng => {
      const snap = snapToNearest(p, candidates, SNAP_RADIUS_M);
      return snap ? { lat: snap.target.lat, lng: snap.target.lng } : p;
    };
    if (m === "draw-slope") {
      setDrawSlopePoints((prev) => {
        const candidates: LatLng[] = [...prev];
        const resort = loadedResortRef.current;
        if (resort?.graph) {
          for (const n of resort.graph.nodes) candidates.push({ lat: n.lat, lng: n.lng });
        }
        if (resort) {
          for (const s of resort.slopes) {
            for (const c of s.coordinates ?? []) candidates.push(fromOsmCoord(c));
          }
        }
        return [...prev, snapVertex(latLng, candidates)];
      });
    }
    if (m === "draw-lift") {
      setDrawLiftPoints((prev) => {
        const candidates: LatLng[] = [...prev];
        const resort = loadedResortRef.current;
        if (resort?.graph) {
          for (const n of resort.graph.nodes) candidates.push({ lat: n.lat, lng: n.lng });
        }
        if (resort) {
          for (const l of resort.lifts) {
            for (const c of l.coordinates ?? []) candidates.push(fromOsmCoord(c));
          }
        }
        return [...prev, snapVertex(latLng, candidates)];
      });
    }
    if (m === "connect-nodes") {
      // Pick the nearest node (existing or session-added) within
      // CONNECT_PICK_RADIUS_M of the click. If the click misses, no-op
      // — user will see the cursor badge telling them what to do.
      const resort = loadedResortRef.current;
      if (!resort?.graph) return;
      const all: { id: string; lat: number; lng: number }[] = [
        ...resort.graph.nodes,
        ...addedGraphNodesRef.current,
      ];
      let nearest: { id: string; lat: number; lng: number } | null = null;
      let nearestD = Infinity;
      for (const n of all) {
        const d = distanceM(latLng, { lat: n.lat, lng: n.lng });
        if (d < nearestD && d <= CONNECT_PICK_RADIUS_M) {
          nearestD = d;
          nearest = n;
        }
      }
      if (!nearest) return;
      pickConnectNodeRef.current(nearest.id);
    }
    if (m === "add-node") {
      // add-node requires an existing graph file — the schema needs
      // `nodes[] minItems: 2` AND `edges[] minItems: 1`, so a brand-
      // new graph can't be authored from this mode alone. When the
      // resort has no graph, the click is silently ignored; a banner
      // in the right rail tells the user why.
      const resort = loadedResortRef.current;
      if (!resort?.graph) return;
      setAddedGraphNodes((prevAdded) => {
        // Dedup: clicks within SNAP_RADIUS_M of an existing graph
        // node (or one this session already dropped) are a no-op.
        // The user can fat-finger the same point without leaving
        // ghost duplicates behind.
        const all: LatLng[] = [
          ...resort.graph!.nodes.map((n) => ({ lat: n.lat, lng: n.lng })),
          ...prevAdded.map((n) => ({ lat: n.lat, lng: n.lng })),
        ];
        if (snapToNearest(latLng, all, SNAP_RADIUS_M)) return prevAdded;

        // ID matches the schema pattern `^n-[a-z0-9-]+$`. The
        // `n-u-` prefix flags it as user-authored (vs. `n-summit`,
        // `n-base-X` from the canonical graph). base36 timestamp +
        // 4-char random keeps the id unique within a single session.
        const id = `n-u-${Date.now().toString(36)}-${Math.random()
          .toString(36)
          .slice(2, 6)}`;
        const node: GraphNode = {
          id,
          lat: latLng.lat,
          lng: latLng.lng,
          alt_m: 0,
          kind: "waypoint",
        };
        // Async elevation fill — same /api/elevation pattern as
        // pick mode. alt_m stays 0 if the lookup fails; user can
        // fix it later via a per-node form (not yet built).
        void (async () => {
          try {
            const res = await fetch(
              `/api/elevation?lat=${latLng.lat}&lng=${latLng.lng}`,
              { cache: "no-store" },
            );
            if (!res.ok) return;
            const body = (await res.json()) as { elevation_m?: number };
            if (typeof body.elevation_m !== "number") return;
            setAddedGraphNodes((prev) =>
              prev.map((n) =>
                n.id === id ? { ...n, alt_m: body.elevation_m! } : n,
              ),
            );
          } catch {
            // Silent — alt_m stays 0. Not fatal for authoring.
          }
        })();
        return [...prevAdded, node];
      });
    }
    // edit-*-geom modes are driven by the editable polyline's own
    // events; map clicks outside the polyline don't change geometry.
  }, []);

  // Keyboard shortcuts for draw-* modes: Enter finalizes (opens the
  // metadata form panel), Escape cancels and drops the in-progress
  // polyline. Two near-identical handlers because the state arrays
  // are independent and the dispatcher needs to know which one to
  // operate on.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const m = modeRef.current;
      if (m === "draw-slope") {
        if (e.key === "Enter") {
          if (drawSlopePoints.length < 2) return;
          e.preventDefault();
          setPendingDrawSlope({ points: drawSlopePoints.slice() });
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDrawSlopePoints([]);
          setPendingDrawSlope(null);
        }
      } else if (m === "draw-lift") {
        if (e.key === "Enter") {
          if (drawLiftPoints.length < 2) return;
          e.preventDefault();
          setPendingDrawLift({ points: drawLiftPoints.slice() });
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDrawLiftPoints([]);
          setPendingDrawLift(null);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawSlopePoints, drawLiftPoints]);

  // ── Render dropped pin markers ────────────────────────────────

  useEffect(() => {
    if (!googleMap.current) return;
    // Add markers for any pick that doesn't have one yet.
    const existingIds = new Set(
      pickMarkersRef.current.map((m) => m.getTitle()),
    );
    for (const p of picks) {
      if (existingIds.has(p.id)) continue;
      const marker = new google.maps.Marker({
        position: { lat: p.lat, lng: p.lng },
        map: googleMap.current,
        title: p.id,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#fb923c", // orange-400
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      pickMarkersRef.current.push(marker);
    }
    // Clean up markers whose pick was removed.
    const aliveIds = new Set(picks.map((p) => p.id));
    pickMarkersRef.current = pickMarkersRef.current.filter((m) => {
      if (aliveIds.has(m.getTitle() ?? "")) return true;
      m.setMap(null);
      return false;
    });
  }, [picks]);

  // ── Render slope polylines ────────────────────────────────────

  // Effective coordinates per slope = baseline ⊕ override, plus any
  // newly-drawn slopes the user has finalized this session. Drawn
  // slopes always render with their authored polyline since they're
  // not in the baseline yet.
  const effectiveSlopes = useMemo(() => {
    if (!loadedResort) return [] as SlopeRecord[];
    const deleted = new Set(deletedSlopeIds);
    const fromBaseline = loadedResort.slopes
      .filter((s) => !deleted.has(s.id))
      .map((s) => {
        const override = slopeOverrides[s.id];
        if (!override) return s;
        return { ...s, ...override };
      });
    return [...fromBaseline, ...addedSlopes];
  }, [loadedResort, slopeOverrides, addedSlopes, deletedSlopeIds]);

  const effectiveLifts = useMemo(() => {
    if (!loadedResort) return [] as LiftRecord[];
    const deleted = new Set(deletedLiftIds);
    const fromBaseline = loadedResort.lifts
      .filter((l) => !deleted.has(l.id))
      .map((l) => {
        const override = liftOverrides[l.id];
        if (!override) return l;
        return { ...l, ...override };
      });
    return [...fromBaseline, ...addedLifts];
  }, [loadedResort, liftOverrides, addedLifts, deletedLiftIds]);

  const effectivePlace = useMemo<PlaceRecord | null>(() => {
    if (!loadedResort) return null;
    if (Object.keys(placeOverride).length === 0) return loadedResort.place;
    return { ...loadedResort.place, ...placeOverride };
  }, [loadedResort, placeOverride]);

  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;

    // Tear down previous polylines if the resort changed. We rebuild
    // every render that touches a slope — cheap given <a few hundred
    // polylines per resort.
    slopeLineRefs.current.forEach((line) => line.setMap(null));
    slopeLineRefs.current.clear();

    if (!loadedResort) return;

    for (const slope of effectiveSlopes) {
      if (!slope.coordinates || slope.coordinates.length < 2) continue;
      const isSelected = slope.id === selectedSlopeId;
      const isEditing = isSelected && mode === "edit-slope-geom";
      const path = slope.coordinates.map((c) => ({ lat: c.lat, lng: c.lon }));
      const polyline = new google.maps.Polyline({
        map,
        path,
        strokeColor: isEditing
          ? SLOPE_EDIT_COLOR
          : isSelected
            ? SLOPE_SELECTED_COLOR
            : SLOPE_BASELINE_COLOR,
        strokeOpacity: 0.9,
        strokeWeight: isSelected ? 4 : 2.5,
        clickable: true,
        editable: isEditing,
      });
      // Click → select, when in select mode. Also flips selection
      // when in edit-slope-geom mode so the user can swap which
      // slope they're editing without backtracking to "Select" first.
      polyline.addListener("click", () => {
        const m = modeRef.current;
        if (m === "select" || m === "edit-slope-geom") {
          selectSlope(slope.id);
        }
      });
      // Mirror path mutations into the override map so save bundles
      // pick them up. The Polyline.path is a MVCArray; listening on
      // 'set_at' / 'insert_at' / 'remove_at' covers all three vertex
      // operations the editable mode exposes.
      if (isEditing) {
        const path = polyline.getPath();
        const sync = () => {
          const arr = path.getArray().map((p) => ({
            lat: p.lat(),
            lon: p.lng(),
          }));
          setSlopeOverrides((prev) => ({
            ...prev,
            [slope.id]: { ...prev[slope.id], coordinates: arr },
          }));
        };
        google.maps.event.addListener(path, "set_at", sync);
        google.maps.event.addListener(path, "insert_at", sync);
        google.maps.event.addListener(path, "remove_at", sync);
      }
      slopeLineRefs.current.set(slope.id, polyline);
    }
  }, [effectiveSlopes, loadedResort, selectedSlopeId, mode]);

  // ── Render lift polylines (parallel to slope render) ─────────

  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;

    liftLineRefs.current.forEach((line) => line.setMap(null));
    liftLineRefs.current.clear();

    if (!loadedResort) return;

    for (const lift of effectiveLifts) {
      if (!lift.coordinates || lift.coordinates.length < 2) continue;
      const isSelected = lift.id === selectedLiftId;
      const isEditing = isSelected && mode === "edit-lift-geom";
      const path = lift.coordinates.map((c) => ({ lat: c.lat, lng: c.lon }));
      const polyline = new google.maps.Polyline({
        map,
        path,
        strokeColor: isEditing
          ? LIFT_EDIT_COLOR
          : isSelected
            ? LIFT_SELECTED_COLOR
            : LIFT_BASELINE_COLOR,
        strokeOpacity: 0.95,
        strokeWeight: isSelected ? 4 : 3,
        clickable: true,
        editable: isEditing,
      });
      polyline.addListener("click", () => {
        const m = modeRef.current;
        if (m === "select" || m === "edit-lift-geom") {
          selectLift(lift.id);
        }
      });
      if (isEditing) {
        const path = polyline.getPath();
        const sync = () => {
          const arr = path.getArray().map((p) => ({
            lat: p.lat(),
            lon: p.lng(),
          }));
          setLiftOverrides((prev) => ({
            ...prev,
            [lift.id]: { ...prev[lift.id], coordinates: arr },
          }));
        };
        google.maps.event.addListener(path, "set_at", sync);
        google.maps.event.addListener(path, "insert_at", sync);
        google.maps.event.addListener(path, "remove_at", sync);
      }
      liftLineRefs.current.set(lift.id, polyline);
    }
  }, [effectiveLifts, loadedResort, selectedLiftId, mode]);

  // ── OSM Overpass re-import ────────────────────────────────────

  const importFromOsm = useCallback(async () => {
    if (!loadedResort) return;
    setOsmImport({ kind: "fetching" });
    const { latitude, longitude } = loadedResort.place.coordinates;
    const radiusM = 5000;
    const query =
      `[out:json][timeout:30];` +
      `way["piste:type"="downhill"](around:${radiusM},${latitude},${longitude});` +
      `out geom;`;
    try {
      const res = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (!res.ok) {
        setOsmImport({
          kind: "error",
          message: `Overpass HTTP ${res.status}`,
        });
        return;
      }
      const body = (await res.json()) as {
        elements: {
          type: string;
          id: number;
          tags?: Record<string, string>;
          geometry?: { lat: number; lon: number }[];
        }[];
      };
      const ways = body.elements.filter((e) => e.type === "way");

      // Map OSM piste:difficulty to the unified-enum string we keep
      // in `SlopeRecord.difficulty`. v1 used the same mapping; v2
      // inlines it since we don't depend on `slope-yaml.ts`.
      const mapDiff = (raw: string | undefined): string => {
        switch ((raw ?? "").toLowerCase()) {
          case "novice":
            return "beginner";
          case "easy":
            return "beginner_intermediate";
          case "intermediate":
            return "intermediate";
          case "advanced":
            return "advanced";
          case "expert":
            return "expert";
          case "freeride":
            return "backcountry";
          default:
            return "intermediate";
        }
      };

      // Skip ways whose endpoints already match an existing slope
      // (~10m equirect tolerance). Avoids re-adding slopes the user
      // already authored.
      const existingEndpoints: { lat: number; lon: number }[] = [];
      for (const s of loadedResort.slopes) {
        const c = s.coordinates ?? [];
        if (c.length === 0) continue;
        existingEndpoints.push(c[0]);
        existingEndpoints.push(c[c.length - 1]);
      }
      const closeTo = (
        a: { lat: number; lon: number },
        b: { lat: number; lon: number },
      ) => distanceM(fromOsmCoord(a), fromOsmCoord(b)) < SNAP_RADIUS_M;

      const newRows: SlopeRecord[] = [];
      for (const w of ways) {
        if (!w.geometry || w.geometry.length < 2) continue;
        const first = w.geometry[0];
        const last = w.geometry[w.geometry.length - 1];
        const isDup = existingEndpoints.some(
          (p) =>
            (closeTo(first, p) &&
              existingEndpoints.some((q) => closeTo(last, q))) ||
            (closeTo(last, p) &&
              existingEndpoints.some((q) => closeTo(first, q))),
        );
        if (isDup) continue;
        const name =
          w.tags?.name ?? w.tags?.["name:en"] ?? `unnamed-osm-${w.id}`;
        newRows.push({
          id: `osm-${w.id}`,
          name,
          type: "run",
          difficulty: mapDiff(w.tags?.["piste:difficulty"]),
          coordinates: w.geometry.map((g) => ({ lat: g.lat, lon: g.lon })),
          connected_slope_ids: [],
          connected_lift_ids: [],
        });
      }
      if (newRows.length > 0) {
        setAddedSlopes((prev) => [...newRows, ...prev]);
      }
      setOsmImport({ kind: "done", added: newRows.length });
    } catch (err) {
      setOsmImport({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [loadedResort]);

  // Reset OSM status when the resort changes — old "added X" toast
  // doesn't apply to the freshly-loaded one.
  useEffect(() => {
    setOsmImport({ kind: "idle" });
  }, [loadedResort?.ref.slug]);

  // Recenter the map on the loaded resort.
  useEffect(() => {
    const map = googleMap.current;
    if (!map || !loadedResort) return;
    const c = loadedResort.place.coordinates;
    map.panTo({ lat: c.latitude, lng: c.longitude });
    map.setZoom(15);
  }, [loadedResort]);

  // ── Draw-slope: in-progress polyline + vertex markers ─────────

  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;
    // Tear down previous primitives.
    if (drawSlopeLineRef.current) {
      drawSlopeLineRef.current.setMap(null);
      drawSlopeLineRef.current = null;
    }
    drawSlopeMarkersRef.current.forEach((m) => m.setMap(null));
    drawSlopeMarkersRef.current = [];

    if (mode !== "draw-slope" || drawSlopePoints.length === 0) return;

    if (drawSlopePoints.length >= 2) {
      const polyline = new google.maps.Polyline({
        map,
        path: drawSlopePoints,
        strokeColor: SLOPE_EDIT_COLOR,
        strokeOpacity: 0.95,
        strokeWeight: 3,
      });
      drawSlopeLineRef.current = polyline;
    }
    // Vertex markers help the user count + see what's been clicked.
    // Right-click a vertex to remove it (also works as long-press on touch).
    drawSlopePoints.forEach((p, i) => {
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `vertex ${i + 1} — right-click to remove`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: SLOPE_EDIT_COLOR,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      marker.addListener("rightclick", () => {
        setDrawSlopePoints((prev) => prev.filter((_, idx) => idx !== i));
      });
      drawSlopeMarkersRef.current.push(marker);
    });
  }, [mode, drawSlopePoints]);

  // ── Draw-lift: in-progress polyline + vertex markers (parallel to slope) ──

  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;
    if (drawLiftLineRef.current) {
      drawLiftLineRef.current.setMap(null);
      drawLiftLineRef.current = null;
    }
    drawLiftMarkersRef.current.forEach((m) => m.setMap(null));
    drawLiftMarkersRef.current = [];

    if (mode !== "draw-lift" || drawLiftPoints.length === 0) return;

    if (drawLiftPoints.length >= 2) {
      const polyline = new google.maps.Polyline({
        map,
        path: drawLiftPoints,
        strokeColor: LIFT_EDIT_COLOR,
        strokeOpacity: 0.95,
        strokeWeight: 3,
      });
      drawLiftLineRef.current = polyline;
    }
    drawLiftPoints.forEach((p, i) => {
      const marker = new google.maps.Marker({
        position: p,
        map,
        title: `vertex ${i + 1} — right-click to remove`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: LIFT_EDIT_COLOR,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      marker.addListener("rightclick", () => {
        setDrawLiftPoints((prev) => prev.filter((_, idx) => idx !== i));
      });
      drawLiftMarkersRef.current.push(marker);
    });
  }, [mode, drawLiftPoints]);

  // ── Graph nodes overlay (existing + this-session additions) ────
  //
  // Only rendered in graph-edit modes so the default slope/lift view
  // stays uncluttered. Existing nodes are dim slate (snap-target
  // hints); newly-added nodes pop in emerald to make this session's
  // authoring visible.
  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;

    // Tear down before re-rendering.
    graphNodeMarkersRef.current.forEach((m) => m.setMap(null));
    graphNodeMarkersRef.current = [];

    const graphMode = mode === "add-node" || mode === "connect-nodes" || mode === "edit-edge";
    if (!graphMode) return;
    if (!loadedResort) return;

    const isConnect = mode === "connect-nodes";
    const existing = loadedResort.graph?.nodes ?? [];

    for (const n of existing) {
      const isPending = anchorNodeId === n.id;
      const marker = new google.maps.Marker({
        position: { lat: n.lat, lng: n.lng },
        map,
        title: `node ${n.id}${n.kind ? ` · ${n.kind}` : ""} · ${n.alt_m.toFixed(0)}m`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          // Bump scale in connect-nodes mode so existing nodes are
          // easier to hit. Pending-from gets the largest treatment.
          scale: isPending ? 9 : isConnect ? 6 : 4,
          fillColor: isPending ? "#facc15" : "#64748b", // yellow-400 vs slate-500
          fillOpacity: isPending ? 1 : 0.85,
          strokeColor: "#ffffff",
          strokeWeight: isPending ? 2 : 1,
        },
      });
      if (isConnect) {
        marker.addListener("click", () => pickConnectNodeRef.current(n.id));
      }
      graphNodeMarkersRef.current.push(marker);
    }

    for (const n of addedGraphNodes) {
      const isPending = anchorNodeId === n.id;
      const marker = new google.maps.Marker({
        position: { lat: n.lat, lng: n.lng },
        map,
        title: isConnect
          ? `new node ${n.id} — click to ${isPending ? "cancel" : "connect"}`
          : `new node ${n.id}${n.kind ? ` · ${n.kind}` : ""} · ${n.alt_m.toFixed(0)}m — right-click to remove`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isPending ? 9 : 7,
          fillColor: isPending ? "#facc15" : "#22c55e", // yellow-400 vs emerald-500
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
      });
      if (isConnect) {
        marker.addListener("click", () => pickConnectNodeRef.current(n.id));
      } else {
        // add-node mode keeps the right-click-to-remove gesture.
        marker.addListener("rightclick", () => {
          setAddedGraphNodes((prev) => prev.filter((x) => x.id !== n.id));
        });
      }
      graphNodeMarkersRef.current.push(marker);
    }
  }, [mode, mapReady, loadedResort, addedGraphNodes, anchorNodeId]);

  // ── Graph edges overlay (connect-nodes + edit-edge only) ──────
  //
  // Renders existing edges in dim slate so the user can see what's
  // already connected, and this-session-added edges in emerald to
  // surface what the current edits look like. Always straight-line
  // 2-point polylines (matching the geometry pickConnectNode
  // produces); when edit-edge ships, it'll render the curved
  // versions instead.
  const graphEdgeLinesRef = useRef<google.maps.Polyline[]>([]);
  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;
    graphEdgeLinesRef.current.forEach((p) => p.setMap(null));
    graphEdgeLinesRef.current = [];

    const showEdges = mode === "connect-nodes" || mode === "edit-edge";
    if (!showEdges || !loadedResort) return;

    const existing = loadedResort.graph?.edges ?? [];
    for (const e of existing) {
      const line = new google.maps.Polyline({
        map,
        path: e.geometry.map((p) => ({ lat: p.lat, lng: p.lng })),
        strokeColor: "#64748b",
        strokeOpacity: 0.55,
        strokeWeight: 2,
      });
      graphEdgeLinesRef.current.push(line);
    }
    for (const e of addedGraphEdges) {
      const line = new google.maps.Polyline({
        map,
        path: e.geometry.map((p) => ({ lat: p.lat, lng: p.lng })),
        strokeColor: "#22c55e",
        strokeOpacity: 0.95,
        strokeWeight: 3,
      });
      graphEdgeLinesRef.current.push(line);
    }
  }, [mode, mapReady, loadedResort, addedGraphEdges]);

  // Esc cancels the pending "from" node in connect-nodes mode.
  // Also cleared automatically when the user leaves connect-nodes
  // (handled in the mode-change effect below).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (modeRef.current !== "connect-nodes") return;
      if (e.key === "Escape") {
        e.preventDefault();
        setAnchorNodeId(null);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Clear pending whenever the user leaves connect-nodes — otherwise
  // a stale "first node selected" indicator follows them into other
  // modes, which is confusing.
  useEffect(() => {
    if (mode !== "connect-nodes" && anchorNodeId !== null) {
      setAnchorNodeId(null);
    }
  }, [mode, anchorNodeId]);

  // Build patch bundle for the saver. PatchBundle shape is
  // `{slug, countryCode, regionSlug, files}` — a flat map of
  // relative-to-resort path → JSON string. PatchSaver ships the
  // whole map to /api/dev/write-resort-patch.
  //
  // We only emit a file for entity types that actually have edits
  // — emitting an unchanged `slopes.json` would still trigger a CI
  // re-validation cycle without changing data.
  const patchBundle = useMemo<PatchBundle | null>(() => {
    if (!loadedResort) return null;
    const slopeEdits = Object.keys(slopeOverrides).length;
    const slopeAdded = addedSlopes.length;
    const slopeDeleted = deletedSlopeIds.length;
    const liftEdits = Object.keys(liftOverrides).length;
    const liftAdded = addedLifts.length;
    const liftDeleted = deletedLiftIds.length;
    const placeEdits = Object.keys(placeOverride).length;
    const graphNodesAdded = addedGraphNodes.length;
    const graphEdgesAdded = addedGraphEdges.length;
    if (
      slopeEdits + slopeAdded + slopeDeleted +
      liftEdits + liftAdded + liftDeleted +
      placeEdits + graphNodesAdded + graphEdgesAdded === 0
    )
      return null;

    // Provenance stamp for every record the user touches. Preserves
    // any pre-existing provenance (e.g. osm_way_id from OSM import)
    // and overrides source/contributor/last_verified to mark the
    // record as user-edited. `contributor` is omitted when the
    // session hasn't resolved yet — PatchSaver gates submit on auth,
    // so by the time the bundle ships, the login is known and the
    // memo will have re-run with it in the deps array.
    const today = new Date().toISOString().slice(0, 10);
    const contributor = sessionUser?.login;
    const stamp = <T extends { provenance?: Provenance }>(record: T): T => ({
      ...record,
      provenance: {
        ...(record.provenance ?? {}),
        source: "user-edit",
        ...(contributor ? { contributor } : {}),
        last_verified: today,
      },
    });

    const files: Record<string, string> = {};

    if (slopeEdits > 0 || slopeAdded > 0 || slopeDeleted > 0) {
      const deleted = new Set(deletedSlopeIds);
      const editedSlopes = loadedResort.slopes
        .filter((s) => !deleted.has(s.id))
        .map((s) =>
          slopeOverrides[s.id] ? stamp({ ...s, ...slopeOverrides[s.id] }) : s,
        );
      const newSlopes = addedSlopes.map(stamp);
      files["slopes.json"] =
        JSON.stringify(
          {
            $schema: "../../../schemas/slope.schema.json",
            country_code: loadedResort.ref.countryCode,
            region_slug: loadedResort.ref.regionSlug,
            place_slug: loadedResort.ref.slug,
            slopes: [...editedSlopes, ...newSlopes],
          },
          null,
          2,
        ) + "\n";
    }
    if (liftEdits > 0 || liftAdded > 0 || liftDeleted > 0) {
      const deleted = new Set(deletedLiftIds);
      const editedLifts = loadedResort.lifts
        .filter((l) => !deleted.has(l.id))
        .map((l) =>
          liftOverrides[l.id] ? stamp({ ...l, ...liftOverrides[l.id] }) : l,
        );
      const newLifts = addedLifts.map(stamp);
      files["lifts.json"] =
        JSON.stringify(
          {
            $schema: "../../../schemas/lift.schema.json",
            country_code: loadedResort.ref.countryCode,
            region_slug: loadedResort.ref.regionSlug,
            place_slug: loadedResort.ref.slug,
            lifts: [...editedLifts, ...newLifts],
          },
          null,
          2,
        ) + "\n";
    }
    if (placeEdits > 0 && effectivePlace) {
      files["place.json"] = JSON.stringify(stamp(effectivePlace), null, 2) + "\n";
    }

    // Graph emission: only when an existing graph is loaded (the
    // schema requires `nodes` min 2 + `edges` min 1, so we can't
    // bootstrap a brand-new graph from added nodes alone). Merged
    // graph = existing.nodes ++ addedGraphNodes, existing edges
    // unchanged. snap_config pass-through preserved.
    if ((graphNodesAdded > 0 || graphEdgesAdded > 0) && loadedResort.graph) {
      const merged: SlopeGraphRecord = {
        ...loadedResort.graph,
        nodes: [...loadedResort.graph.nodes, ...addedGraphNodes],
        edges: [...loadedResort.graph.edges, ...addedGraphEdges],
      };
      files["slope-graph.json"] =
        JSON.stringify(
          {
            $schema: "../../../schemas/slope-graph.schema.json",
            ...merged,
          },
          null,
          2,
        ) + "\n";
    }

    const parts: string[] = [];
    if (slopeEdits > 0) parts.push(`edit ${slopeEdits} slope${slopeEdits === 1 ? "" : "s"}`);
    if (slopeAdded > 0) parts.push(`add ${slopeAdded} slope${slopeAdded === 1 ? "" : "s"}`);
    if (slopeDeleted > 0)
      parts.push(`delete ${slopeDeleted} slope${slopeDeleted === 1 ? "" : "s"}`);
    if (liftEdits > 0) parts.push(`edit ${liftEdits} lift${liftEdits === 1 ? "" : "s"}`);
    if (liftAdded > 0) parts.push(`add ${liftAdded} lift${liftAdded === 1 ? "" : "s"}`);
    if (liftDeleted > 0)
      parts.push(`delete ${liftDeleted} lift${liftDeleted === 1 ? "" : "s"}`);
    if (placeEdits > 0) parts.push("edit place metadata");
    if (graphNodesAdded > 0)
      parts.push(`add ${graphNodesAdded} graph node${graphNodesAdded === 1 ? "" : "s"}`);
    if (graphEdgesAdded > 0)
      parts.push(`add ${graphEdgesAdded} graph edge${graphEdgesAdded === 1 ? "" : "s"}`);

    return {
      slug: loadedResort.ref.slug,
      countryCode: loadedResort.ref.countryCode,
      regionSlug: loadedResort.ref.regionSlug,
      files,
      message: `slope-author-2: ${parts.join(" + ")}`,
    };
  }, [loadedResort, slopeOverrides, addedSlopes, deletedSlopeIds, liftOverrides, addedLifts, deletedLiftIds, placeOverride, effectivePlace, sessionUser?.login, addedGraphNodes, addedGraphEdges]);

  const desc = modeDescriptor(mode);
  const descI18n = MODE_I18N[desc.mode];
  const descLabel = t(descI18n.labelKey);
  const descHint = t(descI18n.hintKey);
  const selectedSlope = selectedSlopeId
    ? effectiveSlopes.find((s) => s.id === selectedSlopeId) ?? null
    : null;
  const selectedLift = selectedLiftId
    ? effectiveLifts.find((l) => l.id === selectedLiftId) ?? null
    : null;

  // `drawerState` is declared near the top of the component (with
  // the other useStates) so the map-resize useEffect can read it.
  const cycleDrawer = () =>
    setDrawerState((s) =>
      s === "peek" ? "half" : s === "half" ? "full" : "peek",
    );
  const drawerMaxH =
    drawerState === "peek"
      ? "max-h-[3.5rem]"
      : drawerState === "half"
        ? "max-h-[50dvh]"
        : "max-h-[80dvh]";

  return (
    <section className="relative flex h-[100dvh] w-full flex-col overflow-hidden bg-[#071521] text-[var(--fg)]">
      <header className="flex-none border-b border-[var(--border)] bg-[var(--bg-surface)] px-3 py-2 md:px-4">
        <div className="flex flex-wrap items-center justify-between gap-2 md:gap-3">
          <div>
            <p className="text-[10px] font-extrabold uppercase tracking-[0.2em] text-[var(--accent-soft)]">
              {t("devEyebrow")}
            </p>
            <h1 className="text-sm font-bold md:text-base">{t("title")}</h1>
          </div>
          <div className="flex items-center gap-2 text-xs md:gap-3">
            <span className="rounded-full bg-[var(--bg-elev)] px-3 py-1 font-semibold text-[var(--fg-muted)]">
              {t("mode")}: <span className="text-[var(--fg)]">{descLabel}</span>
            </span>
            {/* Long hint repeats inside the map's floating badge — hide
                here on mobile so the header stays one line tall. */}
            <span className="hidden text-[var(--fg-muted)] md:inline">{descHint}</span>
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col md:flex-row md:overflow-hidden">
        <ModeToolbar
          mode={mode}
          onModeChange={setMode}
          hasSlope={selectedSlopeId !== null}
          hasLift={selectedLiftId !== null}
        />

        <div className="relative flex-1 min-h-0 md:h-full md:flex-1">
          {mapError ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-[var(--fg-muted)]">
              {t("mapFailed")}: {mapError}
            </div>
          ) : (
            <div ref={mapRef} className="h-full w-full" aria-label="Map canvas" />
          )}
          {!mapReady && !mapError && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-[var(--fg-muted)]">
              {t("loadingMap")}
            </div>
          )}
          {/* Mode hint lives in the desktop header (line ~833) and in
              the mobile drawer handle (below). Floating overlay
              removed — the transparent badge over the map was hard
              to read and competed with Google's controls. */}
        </div>

        <aside
          className={`flex w-full flex-none flex-col overflow-hidden bg-[var(--bg-page)] shadow-2xl transition-[max-height] duration-200 ease-out fixed bottom-0 left-0 right-0 z-30 rounded-t-3xl ${drawerMaxH} md:relative md:bottom-auto md:left-auto md:right-auto md:z-auto md:max-h-none md:w-[24rem] md:border-l md:border-[var(--border)] md:rounded-none md:shadow-none md:transition-none`}
        >
          {/* Mobile drawer handle — click to cycle peek → half → full
              → peek. Surfaces the mode hint inline, replacing the
              floating overlay. Hidden on desktop (md+) where the
              header carries the hint. */}
          <button
            type="button"
            onClick={cycleDrawer}
            aria-label={`${descLabel}: ${descHint} — toggle drawer`}
            aria-expanded={drawerState !== "peek"}
            className="flex w-full flex-none flex-col items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-elev)]/60 px-3 py-2 transition hover:bg-[var(--bg-elev)] md:hidden"
          >
            <span aria-hidden className="block h-1 w-10 rounded-full bg-[var(--fg-dim)]" />
            <span className="line-clamp-1 text-[11px] text-[var(--fg-muted)]">
              <span aria-hidden className="mr-1">{desc.icon}</span>
              <span className="font-semibold text-[var(--fg)]">{descLabel}</span>
              <span className="mx-1">·</span>
              {descHint}
            </span>
          </button>

          <div className="no-scrollbar p-3 space-y-4 overflow-y-auto md:h-full md:overflow-y-auto">
            <ResortLoader onLoad={setLoadedResort} />

            <NewPlaceForm />

            {mode === "draw-slope" && (
              <DrawSlopeStatusPanel
                points={drawSlopePoints}
                pending={pendingDrawSlope !== null}
                onFinishNow={() => {
                  if (drawSlopePoints.length < 2) return;
                  setPendingDrawSlope({ points: drawSlopePoints.slice() });
                }}
                onUndoVertex={() =>
                  setDrawSlopePoints((prev) => prev.slice(0, -1))
                }
                onCancel={() => {
                  setDrawSlopePoints([]);
                  setPendingDrawSlope(null);
                }}
              />
            )}

            {pendingDrawSlope && loadedResort && (
              <FinalizeSlopePanel
                points={pendingDrawSlope.points}
                existingIds={new Set([
                  ...loadedResort.slopes.map((s) => s.id),
                  ...addedSlopes.map((s) => s.id),
                ])}
                onCommit={(record) => {
                  setAddedSlopes((prev) => [...prev, record]);
                  setDrawSlopePoints([]);
                  setPendingDrawSlope(null);
                  setMode("select");
                }}
                onCancel={() => {
                  setPendingDrawSlope(null);
                }}
              />
            )}

            {mode === "connect-nodes" && (
              <ConnectNodesStatusPanel
                hasGraph={!!loadedResort?.graph}
                anchorNodeId={anchorNodeId}
                addedEdgesCount={addedGraphEdges.length}
                onCancelPending={() => setAnchorNodeId(null)}
                onUndoLastEdge={() =>
                  setAddedGraphEdges((prev) => prev.slice(0, -1))
                }
              />
            )}

            {mode === "draw-lift" && (
              <DrawLiftStatusPanel
                points={drawLiftPoints}
                pending={pendingDrawLift !== null}
                onFinishNow={() => {
                  if (drawLiftPoints.length < 2) return;
                  setPendingDrawLift({ points: drawLiftPoints.slice() });
                }}
                onUndoVertex={() =>
                  setDrawLiftPoints((prev) => prev.slice(0, -1))
                }
                onCancel={() => {
                  setDrawLiftPoints([]);
                  setPendingDrawLift(null);
                }}
              />
            )}

            {pendingDrawLift && loadedResort && (
              <FinalizeLiftPanel
                points={pendingDrawLift.points}
                existingIds={new Set([
                  ...loadedResort.lifts.map((l) => l.id),
                  ...addedLifts.map((l) => l.id),
                ])}
                onCommit={(record) => {
                  setAddedLifts((prev) => [...prev, record]);
                  setDrawLiftPoints([]);
                  setPendingDrawLift(null);
                  setMode("select");
                }}
                onCancel={() => {
                  setPendingDrawLift(null);
                }}
              />
            )}

            {loadedResort && effectivePlace && (
              <PlaceMetaPanel
                place={effectivePlace}
                onPatch={(patch) =>
                  setPlaceOverride((prev) => ({ ...prev, ...patch }))
                }
                onReset={() => setPlaceOverride({})}
                hasEdits={Object.keys(placeOverride).length > 0}
              />
            )}

            {loadedResort && (
              <OsmImportPanel
                status={osmImport}
                onImport={importFromOsm}
              />
            )}

            {loadedResort && (
              <SlopeListPanel
                resort={loadedResort}
                effectiveSlopes={effectiveSlopes}
                selectedId={selectedSlopeId}
                onSelect={selectSlope}
                overrides={slopeOverrides}
                deletedCount={deletedSlopeIds.length}
                onRestoreAll={() => setDeletedSlopeIds([])}
                hint={
                  mode === "edit-slope-geom"
                    ? t("slopeListHintEditing")
                    : t("slopeListHintSelect")
                }
              />
            )}

            {selectedSlope && (
              <SlopeMetaPanel
                slope={selectedSlope}
                override={slopeOverrides[selectedSlope.id]}
                onPatch={(patch) =>
                  setSlopeOverrides((prev) => ({
                    ...prev,
                    [selectedSlope.id]: { ...prev[selectedSlope.id], ...patch },
                  }))
                }
                isEditingGeom={mode === "edit-slope-geom"}
                onEditGeom={() => setMode("edit-slope-geom")}
                onResetGeom={() => {
                  // Drop just the coordinates override — keep any
                  // metadata edits intact.
                  setSlopeOverrides((prev) => {
                    const cur = prev[selectedSlope.id];
                    if (!cur) return prev;
                    const { coordinates: _drop, ...rest } = cur;
                    void _drop;
                    if (Object.keys(rest).length === 0) {
                      const next = { ...prev };
                      delete next[selectedSlope.id];
                      return next;
                    }
                    return { ...prev, [selectedSlope.id]: rest };
                  });
                }}
                hasOverrideGeom={
                  Boolean(slopeOverrides[selectedSlope.id]?.coordinates)
                }
                onDelete={() => deleteSlope(selectedSlope.id)}
              />
            )}

            {loadedResort && (
              <LiftListPanel
                effectiveLifts={effectiveLifts}
                selectedId={selectedLiftId}
                onSelect={selectLift}
                overrides={liftOverrides}
                deletedCount={deletedLiftIds.length}
                onRestoreAll={() => setDeletedLiftIds([])}
                hint={
                  mode === "edit-lift-geom"
                    ? t("liftListHintEditing")
                    : t("liftListHintSelect")
                }
              />
            )}

            {selectedLift && (
              <LiftMetaPanel
                lift={selectedLift}
                override={liftOverrides[selectedLift.id]}
                onPatch={(patch) =>
                  setLiftOverrides((prev) => ({
                    ...prev,
                    [selectedLift.id]: { ...prev[selectedLift.id], ...patch },
                  }))
                }
                isEditingGeom={mode === "edit-lift-geom"}
                onEditGeom={() => setMode("edit-lift-geom")}
                onResetGeom={() => {
                  setLiftOverrides((prev) => {
                    const cur = prev[selectedLift.id];
                    if (!cur) return prev;
                    const { coordinates: _drop, ...rest } = cur;
                    void _drop;
                    if (Object.keys(rest).length === 0) {
                      const next = { ...prev };
                      delete next[selectedLift.id];
                      return next;
                    }
                    return { ...prev, [selectedLift.id]: rest };
                  });
                }}
                hasOverrideGeom={
                  Boolean(liftOverrides[selectedLift.id]?.coordinates)
                }
                onDelete={() => deleteLift(selectedLift.id)}
              />
            )}

            {picks.length > 0 && (
              <PickListPanel picks={picks} onClear={() => setPicks([])} />
            )}

            {patchBundle && <PatchSaver bundle={patchBundle} />}
          </div>
        </aside>
      </div>
    </section>
  );
}

// ── Sub-panels ─────────────────────────────────────────────────

function SlopeListPanel({
  resort,
  effectiveSlopes,
  selectedId,
  onSelect,
  overrides,
  hint,
  deletedCount,
  onRestoreAll,
}: {
  resort: LoadedResort;
  effectiveSlopes: SlopeRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  overrides: Record<string, SlopeOverride>;
  hint: string;
  deletedCount: number;
  onRestoreAll: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  return (
    <section>
      <header className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          {t("slopeCountHeader", { count: effectiveSlopes.length })}
        </p>
        <span className="flex items-center gap-2 text-[10px] text-[var(--fg-dim)]">
          {deletedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreAll}
              className="rounded-full bg-[#ef4444]/20 px-1.5 py-0.5 text-[9px] font-semibold text-[#fca5a5] hover:bg-[#ef4444]/30"
              title={t("restoreAllTitle")}
            >
              {t("deletedRestoreChip", { count: deletedCount })}
            </button>
          )}
          <span>{t("editedCount", { count: Object.keys(overrides).length })}</span>
        </span>
      </header>
      <p className="mb-2 text-[10px] text-[var(--fg-dim)]">{hint}</p>
      <ul className="grid gap-1 text-xs">
        {effectiveSlopes.map((s) => {
          const isSelected = s.id === selectedId;
          const dirty = !!overrides[s.id];
          return (
            <li key={s.id}>
              <button
                type="button"
                onClick={() => onSelect(s.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${
                  isSelected
                    ? "bg-[var(--accent)]/15 text-[var(--fg)]"
                    : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev)]"
                }`}
              >
                <span className="truncate font-medium">
                  {s.name || s.id}
                </span>
                <span className="flex flex-none items-center gap-2">
                  {dirty && (
                    <span className="rounded-full bg-[#f59e0b]/20 px-1.5 py-0.5 text-[9px] font-semibold text-[#fbbf24]">
                      edited
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--fg-dim)]">
                    {s.coordinates?.length ?? 0}pt
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-[10px] text-[var(--fg-dim)]">
        Resort: {resort.ref.label}
      </p>
    </section>
  );
}

function SlopeMetaPanel({
  slope,
  override,
  onPatch,
  isEditingGeom,
  onEditGeom,
  onResetGeom,
  hasOverrideGeom,
  onDelete,
}: {
  slope: SlopeRecord;
  override: SlopeOverride | undefined;
  onPatch: (patch: SlopeOverride) => void;
  isEditingGeom: boolean;
  onEditGeom: () => void;
  onResetGeom: () => void;
  hasOverrideGeom: boolean;
  onDelete: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("slopeAuthor");
  // Inputs read from baseline ⊕ override so they reflect any
  // pending edits without requiring a re-fetch.
  const name = override?.name ?? slope.name ?? "";
  const difficulty = (override?.difficulty ?? slope.difficulty ?? "") as string;
  const lengthM = override?.length_m ?? slope.length_m ?? null;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/60 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          {t("selectedSlope")}
        </p>
        <h3 className="mt-0.5 truncate text-sm font-semibold text-[var(--fg)]">
          {slope.name || slope.id}
        </h3>
        <p className="text-[10px] text-[var(--fg-dim)]">
          {t("idVerticesHint", {
            id: slope.id,
            count: slope.coordinates?.length ?? 0,
          })}
        </p>
      </header>
      <div className="grid gap-2 text-xs">
        <LabeledInput
          label={t("nameCanonical")}
          value={name}
          onChange={(v) => onPatch({ name: v })}
        />
        <LocalizedNameEditor
          label={t("nameLocalized")}
          value={
            (override?.name_i18n ?? slope.name_i18n) as
              | Record<string, string>
              | undefined
          }
          onChange={(next) => onPatch({ name_i18n: next })}
          currentLocale={locale}
        />
        <LabeledInput
          label={t("difficulty")}
          value={difficulty}
          onChange={(v) => onPatch({ difficulty: v || null })}
          placeholder="beginner / intermediate / advanced / expert / …"
        />
        <LabeledNumber
          label={t("lengthM")}
          value={lengthM ?? null}
          onChange={(v) => onPatch({ length_m: v })}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {!isEditingGeom ? (
          <button
            type="button"
            onClick={onEditGeom}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)]"
          >
            {t("editGeometry")}
          </button>
        ) : (
          <span className="rounded-md bg-[#22d3ee]/15 px-3 py-1.5 font-semibold text-[#22d3ee]">
            {t("editingGeomNote")}
          </span>
        )}
        {hasOverrideGeom && (
          <button
            type="button"
            onClick={onResetGeom}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            {t("resetGeometry")}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm(t("deleteSlopeConfirm", { name: slope.name || slope.id }))) {
              onDelete();
            }
          }}
          className="ml-auto rounded-md border border-[#ef4444]/40 px-3 py-1.5 font-semibold text-[#fca5a5] hover:bg-[#ef4444]/10 hover:text-[#fecaca]"
        >
          {t("deleteAction")}
        </button>
      </div>
    </section>
  );
}

function LiftListPanel({
  effectiveLifts,
  selectedId,
  onSelect,
  overrides,
  hint,
  deletedCount,
  onRestoreAll,
}: {
  effectiveLifts: LiftRecord[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  overrides: Record<string, LiftOverride>;
  hint: string;
  deletedCount: number;
  onRestoreAll: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  return (
    <section>
      <header className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          {t("liftCountHeader", { count: effectiveLifts.length })}
        </p>
        <span className="flex items-center gap-2 text-[10px] text-[var(--fg-dim)]">
          {deletedCount > 0 && (
            <button
              type="button"
              onClick={onRestoreAll}
              className="rounded-full bg-[#ef4444]/20 px-1.5 py-0.5 text-[9px] font-semibold text-[#fca5a5] hover:bg-[#ef4444]/30"
              title={t("restoreAllTitle")}
            >
              {t("deletedRestoreChip", { count: deletedCount })}
            </button>
          )}
          <span>{t("editedCount", { count: Object.keys(overrides).length })}</span>
        </span>
      </header>
      <p className="mb-2 text-[10px] text-[var(--fg-dim)]">{hint}</p>
      <ul className="grid gap-1 text-xs">
        {effectiveLifts.map((l) => {
          const isSelected = l.id === selectedId;
          const dirty = !!overrides[l.id];
          return (
            <li key={l.id}>
              <button
                type="button"
                onClick={() => onSelect(l.id)}
                className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left ${
                  isSelected
                    ? "bg-[var(--accent)]/15 text-[var(--fg)]"
                    : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev)]"
                }`}
              >
                <span className="truncate font-medium">{l.name || l.id}</span>
                <span className="flex flex-none items-center gap-2">
                  {dirty && (
                    <span className="rounded-full bg-[#f59e0b]/20 px-1.5 py-0.5 text-[9px] font-semibold text-[#fbbf24]">
                      edited
                    </span>
                  )}
                  <span className="text-[10px] text-[var(--fg-dim)]">
                    {l.coordinates?.length ?? 0}pt · {l.type ?? "—"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LiftMetaPanel({
  lift,
  override,
  onPatch,
  isEditingGeom,
  onEditGeom,
  onResetGeom,
  hasOverrideGeom,
  onDelete,
}: {
  lift: LiftRecord;
  override: LiftOverride | undefined;
  onPatch: (patch: LiftOverride) => void;
  isEditingGeom: boolean;
  onEditGeom: () => void;
  onResetGeom: () => void;
  hasOverrideGeom: boolean;
  onDelete: () => void;
}) {
  const locale = useLocale();
  const t = useTranslations("slopeAuthor");
  const name = override?.name ?? lift.name ?? "";
  const type = override?.type ?? lift.type ?? "";
  const capacity = override?.capacity_per_hour ?? lift.capacity_per_hour ?? null;
  const lengthM = override?.length_m ?? lift.length_m ?? null;
  const verticalM = override?.vertical_m ?? lift.vertical_m ?? null;
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/60 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          {t("selectedLift")}
        </p>
        <h3 className="mt-0.5 truncate text-sm font-semibold text-[var(--fg)]">
          {lift.name || lift.id}
        </h3>
        <p className="text-[10px] text-[var(--fg-dim)]">
          {t("idVerticesHint", {
            id: lift.id,
            count: lift.coordinates?.length ?? 0,
          })}
        </p>
      </header>
      <div className="grid gap-2 text-xs">
        <LabeledInput
          label={t("nameCanonical")}
          value={name}
          onChange={(v) => onPatch({ name: v })}
        />
        <LocalizedNameEditor
          label={t("nameLocalized")}
          value={
            (override?.name_i18n ?? lift.name_i18n) as
              | Record<string, string>
              | undefined
          }
          onChange={(next) => onPatch({ name_i18n: next })}
          currentLocale={locale}
        />
        <label className="grid gap-1 text-[10px] text-[var(--fg-muted)]">
          <span className="font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
            {t("typeLabel")}
          </span>
          <select
            value={type}
            onChange={(e) => onPatch({ type: e.target.value || undefined })}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--fg)]"
          >
            <option value="">—</option>
            {LIFT_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
            {type && !LIFT_TYPE_OPTIONS.includes(type as (typeof LIFT_TYPE_OPTIONS)[number]) && (
              <option value={type}>{type} (custom)</option>
            )}
          </select>
        </label>
        <LabeledNumber
          label={t("capacityPerHour")}
          value={capacity ?? null}
          onChange={(v) => onPatch({ capacity_per_hour: v })}
        />
        <LabeledNumber
          label={t("lengthM")}
          value={lengthM ?? null}
          onChange={(v) => onPatch({ length_m: v })}
        />
        <LabeledNumber
          label={t("verticalM")}
          value={verticalM ?? null}
          onChange={(v) => onPatch({ vertical_m: v })}
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        {!isEditingGeom ? (
          <button
            type="button"
            onClick={onEditGeom}
            className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)]"
          >
            {t("editGeometry")}
          </button>
        ) : (
          <span className="rounded-md bg-[#22d3ee]/15 px-3 py-1.5 font-semibold text-[#22d3ee]">
            {t("editingGeomNote")}
          </span>
        )}
        {hasOverrideGeom && (
          <button
            type="button"
            onClick={onResetGeom}
            className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            {t("resetGeometry")}
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            if (confirm(t("deleteLiftConfirm", { name: lift.name || lift.id }))) {
              onDelete();
            }
          }}
          className="ml-auto rounded-md border border-[#ef4444]/40 px-3 py-1.5 font-semibold text-[#fca5a5] hover:bg-[#ef4444]/10 hover:text-[#fecaca]"
        >
          {t("deleteAction")}
        </button>
      </div>
    </section>
  );
}

function PlaceMetaPanel({
  place,
  onPatch,
  onReset,
  hasEdits,
}: {
  place: PlaceRecord;
  onPatch: (patch: Partial<PlaceRecord>) => void;
  onReset: () => void;
  hasEdits: boolean;
}) {
  const locale = useLocale();
  const baseM = place.elevations?.base_m ?? null;
  const summitM = place.elevations?.summit_m ?? null;
  const tagsCsv = (place.tags ?? []).join(", ");
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/60 p-3">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
            Place / ski area
          </p>
          <h3 className="mt-0.5 truncate text-sm font-semibold text-[var(--fg)]">
            {place.name}
          </h3>
          <p className="text-[10px] text-[var(--fg-dim)]">
            {place.country_code}/{place.region_slug}/{place.place_slug}
            {hasEdits ? " · edited" : ""}
          </p>
        </div>
        {hasEdits && (
          <button
            type="button"
            onClick={onReset}
            className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
          >
            Reset
          </button>
        )}
      </header>
      <div className="grid gap-2 text-xs">
        <LabeledInput
          label="Name (canonical)"
          value={place.name}
          onChange={(v) => onPatch({ name: v })}
        />
        <LocalizedNameEditor
          label="Name · localized"
          value={
            (place as PlaceRecord & { name_i18n?: Record<string, string> })
              .name_i18n
          }
          onChange={(next) =>
            onPatch({
              name_i18n: next,
            } as Partial<PlaceRecord>)
          }
          currentLocale={locale}
        />
        <LabeledInput
          label="Region (display)"
          value={place.region}
          onChange={(v) => onPatch({ region: v })}
        />
        <LabeledInput
          label="Country (display)"
          value={place.country}
          onChange={(v) => onPatch({ country: v })}
        />
        <div className="grid grid-cols-2 gap-2">
          <LabeledNumber
            label="Base elev (m)"
            value={baseM}
            onChange={(v) => {
              const next = { ...(place.elevations ?? {}), base_m: v ?? undefined };
              onPatch({ elevations: next });
            }}
          />
          <LabeledNumber
            label="Summit elev (m)"
            value={summitM}
            onChange={(v) => {
              const next = { ...(place.elevations ?? {}), summit_m: v ?? undefined };
              onPatch({ elevations: next });
            }}
          />
        </div>
        <LabeledInput
          label="Tags (comma-separated)"
          value={tagsCsv}
          onChange={(v) =>
            onPatch({
              tags: v
                .split(",")
                .map((s) => s.trim())
                .filter((s) => s.length > 0),
            })
          }
          placeholder="e.g. resort, day_use, has_terrain_park"
        />
      </div>
      <p className="mt-2 text-[10px] text-[var(--fg-dim)]">
        Slug + region/country code are locked — changing them would
        relocate the file in the registry tree.
      </p>
    </section>
  );
}

// ── Form helpers ──────────────────────────────────────────────

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="grid gap-1 text-[10px] text-[var(--fg-muted)]">
      <span className="font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="rounded-md border border-[var(--border)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--fg)]"
      />
    </label>
  );
}

/**
 * Localized-name editor — renders one input per locale in I18N_LOCALES.
 * Caller wires the result back through `onChange` as a fully-formed
 * `Record<locale, string>` (empty strings dropped, all-empty becomes
 * undefined so the patch stays clean).
 *
 * Used for slope `name_i18n`, lift `name_i18n`, and place `name_i18n`.
 * The schema field name is the same across all three so the same
 * helper drops in everywhere.
 */
function LocalizedNameEditor({
  label,
  value,
  onChange,
  currentLocale,
}: {
  label: string;
  value: Record<string, string> | undefined;
  onChange: (next: Record<string, string> | undefined) => void;
  currentLocale: string;
}) {
  function patchLocale(locale: I18nLocale, next: string) {
    const merged: Record<string, string> = { ...(value ?? {}) };
    if (next.trim() === "") delete merged[locale];
    else merged[locale] = next;
    onChange(Object.keys(merged).length === 0 ? undefined : merged);
  }

  const localeLabels: Record<I18nLocale, string> = {
    ko: "한국어",
    en: "English",
    ja: "日本語",
  };

  return (
    <div className="grid gap-1 text-[10px] text-[var(--fg-muted)]">
      <span className="font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
        {label}
      </span>
      <div className="grid grid-cols-3 gap-2">
        {I18N_LOCALES.map((locale) => (
          <label key={locale} className="grid gap-1">
            <span className="text-[9px] uppercase tracking-wider text-[var(--fg-dim)]">
              {locale} {currentLocale === locale ? "✓" : ""}
              <br />
              {localeLabels[locale]}
            </span>
            <input
              type="text"
              value={value?.[locale] ?? ""}
              onChange={(e) => patchLocale(locale, e.target.value)}
              className="rounded-md border border-[var(--border)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--fg)]"
            />
          </label>
        ))}
      </div>
    </div>
  );
}

function LabeledNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
}) {
  return (
    <label className="grid gap-1 text-[10px] text-[var(--fg-muted)]">
      <span className="font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
        {label}
      </span>
      <input
        type="number"
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") onChange(null);
          else {
            const n = Number(raw);
            onChange(Number.isFinite(n) ? n : null);
          }
        }}
        className="rounded-md border border-[var(--border)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--fg)]"
      />
    </label>
  );
}

/**
 * Status panel that appears in the right rail while draw-slope mode
 * is active. Shows the live vertex count + the keyboard shortcuts +
 * fallback buttons (Finish / Undo last vertex / Cancel) for users
 * who'd rather click than press Enter.
 */
function ConnectNodesStatusPanel({
  hasGraph,
  anchorNodeId,
  addedEdgesCount,
  onCancelPending,
  onUndoLastEdge,
}: {
  hasGraph: boolean;
  anchorNodeId: string | null;
  addedEdgesCount: number;
  onCancelPending: () => void;
  onUndoLastEdge: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  if (!hasGraph) {
    return (
      <section className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-300">
          {t("connectNodesMode")}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("connectNodesNeedGraph")}
        </p>
      </section>
    );
  }
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#22d3ee]">
          {t("connectNodesMode")} ·{" "}
          {anchorNodeId
            ? t("connectNodesPickSecond")
            : t("connectNodesPickFirst")}
        </p>
        {anchorNodeId && (
          <p className="mt-1 break-all text-[10px] text-[var(--fg-muted)]">
            {t("connectNodesFromLabel")}: <code>{anchorNodeId}</code>
          </p>
        )}
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("connectNodesAddedCount", { count: addedEdgesCount })}
        </p>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onCancelPending}
          disabled={!anchorNodeId}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-red-300 hover:text-red-200 disabled:opacity-40"
        >
          {t("connectNodesCancelPending")}
        </button>
        <button
          type="button"
          onClick={onUndoLastEdge}
          disabled={addedEdgesCount === 0}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-40"
        >
          {t("connectNodesUndoLast")}
        </button>
      </div>
    </section>
  );
}

function DrawSlopeStatusPanel({
  points,
  pending,
  onFinishNow,
  onUndoVertex,
  onCancel,
}: {
  points: { lat: number; lng: number }[];
  pending: boolean;
  onFinishNow: () => void;
  onUndoVertex: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#22d3ee]">
          Drawing slope · {points.length} vertex{points.length === 1 ? "" : "es"}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          Click on the map to add vertices. Press <kbd className="rounded bg-[var(--bg-elev)] px-1">Enter</kbd> when done, <kbd className="rounded bg-[var(--bg-elev)] px-1">Esc</kbd> to cancel.
        </p>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onFinishNow}
          disabled={pending || points.length < 2}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)] disabled:opacity-40"
        >
          Finish ({points.length}pt)
        </button>
        <button
          type="button"
          onClick={onUndoVertex}
          disabled={points.length === 0}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-40"
        >
          Undo vertex
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-red-300 hover:text-red-200"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/**
 * Finalize panel that appears when the user presses Enter on a draw
 * with ≥2 vertices. Asks for the slope id (must be unique within
 * the resort), name, optional difficulty. On commit, the parent
 * appends the resulting `SlopeRecord` to `addedSlopes` and the patch
 * bundle picks it up under slopes.json.
 */
function FinalizeSlopePanel({
  points,
  existingIds,
  onCommit,
  onCancel,
}: {
  points: { lat: number; lng: number }[];
  existingIds: Set<string>;
  onCommit: (record: SlopeRecord) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(() => generateSlopeId(existingIds));
  const [name, setName] = useState("");
  const [difficulty, setDifficulty] = useState<string>("");

  const idTrimmed = id.trim();
  const nameTrimmed = name.trim();
  const idClash = existingIds.has(idTrimmed);
  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(idTrimmed) && !idClash;
  const canSave = idValid && nameTrimmed.length > 0;

  function commit() {
    if (!canSave) return;
    onCommit({
      id: idTrimmed,
      name: nameTrimmed,
      type: "run",
      difficulty: difficulty || null,
      coordinates: points.map((p) => ({ lat: p.lat, lon: p.lng })),
      connected_slope_ids: [],
      connected_lift_ids: [],
    });
  }

  return (
    <section className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          Finalize new slope
        </p>
        <p className="text-[10px] text-[var(--fg-dim)]">
          {points.length} vertices · click Save to add this slope to the patch.
        </p>
      </header>
      <div className="grid gap-2 text-xs">
        <LabeledInput
          label="ID (lowercase, hyphens, unique)"
          value={id}
          onChange={setId}
          placeholder="e.g. blue-line"
        />
        {idClash && (
          <p className="text-[10px] text-red-300">
            ID already in use; pick a different one.
          </p>
        )}
        {!idClash && idTrimmed && !idValid && (
          <p className="text-[10px] text-red-300">
            ID must be lowercase letters / digits / hyphens, starting with a letter or digit.
          </p>
        )}
        <LabeledInput label="Name" value={name} onChange={setName} />
        <LabeledInput
          label="Difficulty (optional)"
          value={difficulty}
          onChange={setDifficulty}
          placeholder="beginner / intermediate / advanced / expert / …"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          disabled={!canSave}
          onClick={commit}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)] disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Back to drawing
        </button>
      </div>
    </section>
  );
}

/**
 * Generate a candidate slope id by walking `slope-1`, `slope-2`, …
 * until we find one that doesn't collide with the resort's existing
 * ids. Caller can rename freely; this just gives a sensible default
 * so Save isn't blocked on the user picking a name first.
 */
function generateSlopeId(existing: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const candidate = `slope-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `slope-${Date.now()}`;
}

function generateLiftId(existing: Set<string>): string {
  for (let i = 1; i < 10000; i++) {
    const candidate = `lift-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `lift-${Date.now()}`;
}

/** Sibling of DrawSlopeStatusPanel — same shape, lift-tinted. */
function DrawLiftStatusPanel({
  points,
  pending,
  onFinishNow,
  onUndoVertex,
  onCancel,
}: {
  points: { lat: number; lng: number }[];
  pending: boolean;
  onFinishNow: () => void;
  onUndoVertex: () => void;
  onCancel: () => void;
}) {
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[#22d3ee]">
          Drawing lift · {points.length} vertex{points.length === 1 ? "" : "es"}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          Click on the map to add vertices. Press <kbd className="rounded bg-[var(--bg-elev)] px-1">Enter</kbd> when done, <kbd className="rounded bg-[var(--bg-elev)] px-1">Esc</kbd> to cancel.
        </p>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onFinishNow}
          disabled={pending || points.length < 2}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)] disabled:opacity-40"
        >
          Finish ({points.length}pt)
        </button>
        <button
          type="button"
          onClick={onUndoVertex}
          disabled={points.length === 0}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)] disabled:opacity-40"
        >
          Undo vertex
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-red-300 hover:text-red-200"
        >
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Sibling of FinalizeSlopePanel — same id/name pattern, swaps
 *  difficulty for a lift type picker (chair_lift / gondola / …). */
function FinalizeLiftPanel({
  points,
  existingIds,
  onCommit,
  onCancel,
}: {
  points: { lat: number; lng: number }[];
  existingIds: Set<string>;
  onCommit: (record: LiftRecord) => void;
  onCancel: () => void;
}) {
  const [id, setId] = useState(() => generateLiftId(existingIds));
  const [name, setName] = useState("");
  const [type, setType] = useState<string>("chair_lift");

  const idTrimmed = id.trim();
  const nameTrimmed = name.trim();
  const idClash = existingIds.has(idTrimmed);
  const idValid = /^[a-z0-9][a-z0-9-]*$/.test(idTrimmed) && !idClash;
  const canSave = idValid && nameTrimmed.length > 0;

  function commit() {
    if (!canSave) return;
    onCommit({
      id: idTrimmed,
      name: nameTrimmed,
      type: type || undefined,
      coordinates: points.map((p) => ({ lat: p.lat, lon: p.lng })),
    });
  }

  return (
    <section className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          Finalize new lift
        </p>
        <p className="text-[10px] text-[var(--fg-dim)]">
          {points.length} vertices · click Save to add this lift to the patch.
        </p>
      </header>
      <div className="grid gap-2 text-xs">
        <LabeledInput
          label="ID (lowercase, hyphens, unique)"
          value={id}
          onChange={setId}
          placeholder="e.g. emerald-quad"
        />
        {idClash && (
          <p className="text-[10px] text-red-300">
            ID already in use; pick a different one.
          </p>
        )}
        {!idClash && idTrimmed && !idValid && (
          <p className="text-[10px] text-red-300">
            ID must be lowercase letters / digits / hyphens, starting with a letter or digit.
          </p>
        )}
        <LabeledInput label="Name" value={name} onChange={setName} />
        <label className="grid gap-1 text-[10px] text-[var(--fg-muted)]">
          <span className="font-semibold uppercase tracking-widest text-[var(--fg-dim)]">
            Type
          </span>
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded-md border border-[var(--border)] bg-[var(--bg-page)] px-2 py-1 text-xs text-[var(--fg)]"
          >
            {LIFT_TYPE_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          disabled={!canSave}
          onClick={commit}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)] disabled:opacity-40"
        >
          Save
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Back to drawing
        </button>
      </div>
    </section>
  );
}

/**
 * Collapsible "create new place / ski area" form. Builds the
 * minimum-viable resort directory in open-ski-data:
 *   registry/{countryCode}/{regionSlug}/{slug}/place.json   (full record)
 *   registry/{countryCode}/{regionSlug}/{slug}/slopes.json  (empty list)
 *   registry/{countryCode}/{regionSlug}/{slug}/lifts.json   (empty list)
 *   registry/{countryCode}/{regionSlug}/{slug}/webcams.json (empty list)
 *
 * Posts directly to /api/dev/write-resort-patch (the same endpoint
 * the existing PatchSaver uses), which creates a fresh branch on the
 * local open-ski-data clone and pushes it to GitHub. The new place
 * shows up in the resort dropdown after the PR merges + CI
 * regenerates `registry/index.json`.
 *
 * Form is collapsed by default — only the "+ New place" affordance
 * shows in the rail until the user clicks to expand. Keeps the rail
 * uncluttered for the common edit-existing-resort flow.
 */
function NewPlaceForm() {
  const t = useTranslations("slopeAuthor");
  const { user, octokit } = useSession();
  const [open, setOpen] = useState(false);
  const [countryCode, setCountryCode] = useState("");
  const [regionSlug, setRegionSlug] = useState("");
  const [placeSlug, setPlaceSlug] = useState("");
  const [name, setName] = useState("");
  const [region, setRegion] = useState("");
  const [country, setCountry] = useState("");
  const [lat, setLat] = useState<number | null>(null);
  const [lng, setLng] = useState<number | null>(null);
  const [baseM, setBaseM] = useState<number | null>(null);
  const [summitM, setSummitM] = useState<number | null>(null);
  const [tagsCsv, setTagsCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "error"; message: string }
    | { kind: "ok"; branchName: string; branchUrl: string; actionsUrl: string }
  >({ kind: "idle" });

  const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
  const COUNTRY_RE = /^[a-z]{2,3}$/;

  const ccTrimmed = countryCode.trim().toLowerCase();
  const rsTrimmed = regionSlug.trim().toLowerCase();
  const psTrimmed = placeSlug.trim().toLowerCase();
  const nameTrimmed = name.trim();

  const ccOk = COUNTRY_RE.test(ccTrimmed);
  const rsOk = SLUG_RE.test(rsTrimmed);
  const psOk = SLUG_RE.test(psTrimmed);
  const nameOk = nameTrimmed.length > 0;
  const latOk = lat != null && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const lngOk = lng != null && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  const canSave = ccOk && rsOk && psOk && nameOk && latOk && lngOk && !busy;

  async function submit() {
    if (!canSave) return;
    setBusy(true);
    setResult({ kind: "idle" });
    try {
      const tags = tagsCsv
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      const elevations: Record<string, number> = {};
      if (baseM != null) elevations.base_m = baseM;
      if (summitM != null) elevations.summit_m = summitM;

      const placeJson = {
        country_code: ccTrimmed,
        region_slug: rsTrimmed,
        place_slug: psTrimmed,
        name: nameTrimmed,
        region: region.trim() || rsTrimmed,
        country: country.trim() || ccTrimmed.toUpperCase(),
        coordinates: { latitude: lat, longitude: lng },
        ...(Object.keys(elevations).length > 0 ? { elevations } : {}),
        ...(tags.length > 0 ? { tags } : {}),
      };
      const slopesJson = {
        $schema: "../../../schemas/slope.schema.json",
        country_code: ccTrimmed,
        region_slug: rsTrimmed,
        place_slug: psTrimmed,
        slopes: [],
      };
      const liftsJson = {
        $schema: "../../../schemas/lift.schema.json",
        country_code: ccTrimmed,
        region_slug: rsTrimmed,
        place_slug: psTrimmed,
        lifts: [],
      };
      const webcamsJson = {
        $schema: "../../../schemas/webcam.schema.json",
        country_code: ccTrimmed,
        region_slug: rsTrimmed,
        place_slug: psTrimmed,
        webcams: [],
      };
      if (!user || !octokit) {
        setResult({
          kind: "error",
          message: "Sign in with GitHub to create a new place.",
        });
        return;
      }
      const contribution = await contribute({
        octokit,
        user,
        slug: psTrimmed,
        countryCode: ccTrimmed,
        regionSlug: rsTrimmed,
        files: {
          "place.json": JSON.stringify(placeJson, null, 2) + "\n",
          "slopes.json": JSON.stringify(slopesJson, null, 2) + "\n",
          "lifts.json": JSON.stringify(liftsJson, null, 2) + "\n",
          "webcams.json": JSON.stringify(webcamsJson, null, 2) + "\n",
        },
        commitMessage: `Add ${psTrimmed} via open-ski-data editor`,
        prTitle: `Add ${ccTrimmed}/${rsTrimmed}/${psTrimmed}`,
      });
      // `actionsUrl` is repurposed to mean "review URL" — for the
      // public-contributor flow that's the PR; for a maintainer
      // direct-commit (no PR) we fall back to the commit URL.
      setResult({
        kind: "ok",
        branchName: contribution.branchName,
        branchUrl: contribution.forkBranchUrl,
        actionsUrl: contribution.prUrl ?? contribution.forkBranchUrl,
      });
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-md border border-dashed border-[var(--border)] px-3 py-2 text-xs font-semibold text-[var(--accent-soft)] hover:bg-[var(--bg-elev)]"
      >
        {t("newPlaceCallout")}
      </button>
    );
  }

  return (
    <section className="rounded-lg border border-[var(--accent)]/40 bg-[var(--accent)]/10 p-3">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
            {t("newPlaceTitle")}
          </p>
          <p className="text-[10px] text-[var(--fg-dim)]">
            Creates the registry directory + empty slopes / lifts / webcams.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-md border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Close
        </button>
      </header>
      <div className="grid gap-2 text-xs">
        <div className="grid grid-cols-3 gap-2">
          <LabeledInput
            label="Country code"
            value={countryCode}
            onChange={setCountryCode}
            placeholder="e.g. ca"
          />
          <LabeledInput
            label="Region slug"
            value={regionSlug}
            onChange={setRegionSlug}
            placeholder="e.g. british-columbia"
          />
          <LabeledInput
            label="Place slug"
            value={placeSlug}
            onChange={setPlaceSlug}
            placeholder="e.g. revelstoke"
          />
        </div>
        {!ccOk && countryCode.length > 0 && (
          <p className="text-[10px] text-red-300">
            Country code: 2–3 lowercase letters.
          </p>
        )}
        {!rsOk && regionSlug.length > 0 && (
          <p className="text-[10px] text-red-300">
            Region slug must be kebab-case (a-z0-9 + hyphens).
          </p>
        )}
        {!psOk && placeSlug.length > 0 && (
          <p className="text-[10px] text-red-300">
            Place slug must be kebab-case (a-z0-9 + hyphens).
          </p>
        )}
        <LabeledInput label="Display name" value={name} onChange={setName} />
        <div className="grid grid-cols-2 gap-2">
          <LabeledInput
            label="Region (display)"
            value={region}
            onChange={setRegion}
            placeholder="defaults to region slug"
          />
          <LabeledInput
            label="Country (display)"
            value={country}
            onChange={setCountry}
            placeholder={`defaults to ${ccTrimmed.toUpperCase() || "country code"}`}
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <LabeledNumber label="Latitude" value={lat} onChange={setLat} />
          <LabeledNumber label="Longitude" value={lng} onChange={setLng} />
        </div>
        {(!latOk || !lngOk) && (lat != null || lng != null) && (
          <p className="text-[10px] text-red-300">
            Lat must be -90..90 and lng -180..180.
          </p>
        )}
        <div className="grid grid-cols-2 gap-2">
          <LabeledNumber
            label="Base elev (m)"
            value={baseM}
            onChange={setBaseM}
          />
          <LabeledNumber
            label="Summit elev (m)"
            value={summitM}
            onChange={setSummitM}
          />
        </div>
        <LabeledInput
          label="Tags (comma-separated, optional)"
          value={tagsCsv}
          onChange={setTagsCsv}
          placeholder="e.g. resort, has_terrain_park"
        />
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
        <button
          type="button"
          onClick={submit}
          disabled={!canSave}
          className="rounded-md bg-[var(--accent)] px-3 py-1.5 font-semibold text-[var(--accent-ink)] disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create place + push branch"}
        </button>
      </div>
      {result.kind === "error" && (
        <p className="mt-2 text-[10px] text-red-300">Error: {result.message}</p>
      )}
      {result.kind === "ok" && (
        <div className="mt-2 grid gap-1 text-[10px] text-[var(--fg-muted)]">
          <p>
            Branch <span className="font-mono">{result.branchName}</span>{" "}
            pushed.
          </p>
          <p>
            <a
              className="underline"
              href={result.branchUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open branch on GitHub
            </a>
            {" · "}
            <a
              className="underline"
              href={result.actionsUrl}
              target="_blank"
              rel="noreferrer"
            >
              CI run
            </a>
          </p>
          <p className="text-[var(--fg-dim)]">
            New place will appear in the dropdown after merge + index
            regeneration.
          </p>
        </div>
      )}
    </section>
  );
}

/**
 * "Import from OSM" affordance that lives next to the slope list.
 * Pulls `piste:type=downhill` ways from public Overpass within 5km
 * of the resort centre, dedupes against the existing slope endpoints,
 * and appends the rest as added (drawn) slopes for the user to
 * review / rename / save.
 *
 * This is a lossy import — OSM names are often missing or
 * `unnamed-osm-<id>` placeholders, and difficulty mapping
 * (piste:difficulty → unified enum) is conservative
 * ("intermediate" by default). The user is expected to walk the
 * added rows, fix names, set the right difficulty, drop the bad
 * ones, then commit.
 */
function OsmImportPanel({
  status,
  onImport,
}: {
  status:
    | { kind: "idle" }
    | { kind: "fetching" }
    | { kind: "done"; added: number }
    | { kind: "error"; message: string };
  onImport: () => void;
}) {
  return (
    <section className="rounded-lg border border-[var(--border)] bg-[var(--bg-surface)]/60 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          Import from OpenStreetMap
        </p>
        <p className="mt-0.5 text-[10px] text-[var(--fg-dim)]">
          Pulls <code>piste:type=downhill</code> ways from Overpass
          within 5km of the resort centre. Dedupes against existing
          slope endpoints (~10m tolerance); the rest land as added
          slopes for you to rename + correct difficulty before saving.
        </p>
      </header>
      <button
        type="button"
        onClick={onImport}
        disabled={status.kind === "fetching"}
        className="rounded-md bg-[var(--accent)] px-3 py-1.5 text-xs font-semibold text-[var(--accent-ink)] disabled:opacity-50"
      >
        {status.kind === "fetching" ? "Fetching OSM…" : "🌐 Fetch from OSM"}
      </button>
      {status.kind === "done" && (
        <p className="mt-2 text-[10px] text-[var(--fg-muted)]">
          ✓ added {status.added} OSM piste{status.added !== 1 ? "s" : ""} as
          drafted slopes. Scroll the slope list to review.
        </p>
      )}
      {status.kind === "error" && (
        <p className="mt-2 text-[10px] text-red-300">
          OSM import failed: {status.message}
        </p>
      )}
    </section>
  );
}

function PickListPanel({
  picks,
  onClear,
}: {
  picks: PickedPoint[];
  onClear: () => void;
}) {
  return (
    <section>
      <header className="mb-1 flex items-center justify-between">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          Picks ({picks.length})
        </p>
        <button
          type="button"
          onClick={onClear}
          className="text-[10px] text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          Clear
        </button>
      </header>
      <ul className="grid gap-1 font-mono text-[10px] text-[var(--fg-muted)]">
        {picks.map((p) => (
          <li key={p.id} className="rounded bg-[var(--bg-elev)] px-2 py-1">
            {p.lat.toFixed(5)}, {p.lng.toFixed(5)} ·{" "}
            {p.elevation_m != null
              ? `${p.elevation_m.toFixed(1)} m`
              : p.elevation_error
                ? `err: ${p.elevation_error}`
                : "fetching…"}
          </li>
        ))}
      </ul>
    </section>
  );
}
