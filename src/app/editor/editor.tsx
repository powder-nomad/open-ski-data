"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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
  type GraphNodeKind,
  type GraphEdge,
  type SlopeGraphRecord,
} from "@/lib/resort-loader";
import { PatchSaver, type PatchBundle } from "@/lib/ci-status";
import { useSession } from "@/lib/use-session";
import {
  contribute,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
} from "@/lib/github-client";
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
// merge-close-nodes (step 6b) threshold. Tighter than SNAP_RADIUS_M
// because merging is destructive and must be the user's explicit
// intent — 2m is closer than any typical authoring drift, so a
// surfaced pair is almost certainly a real duplicate.
const MERGE_THRESHOLD_M = 2;
// Lint: a slope/lift counts as "detached" when neither endpoint is
// within this distance of any live graph node. Slightly wider than
// SNAP_RADIUS_M so a hand-snapped endpoint isn't flagged on the next
// session due to coordinate-rounding drift.
const LINT_DETACH_RADIUS_M = 20;

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
type EdgeOverride = Partial<GraphEdge>;

// Graph-edge polyline colors. Existing baseline edges read as dim
// slate so they don't compete with the brighter session-added edges
// (emerald). When an edge is being edited, both kinds switch to cyan
// to match the slope/lift edit treatment.
const EDGE_BASELINE_COLOR = "#64748b"; // slate-500
const EDGE_ADDED_COLOR = "#22c55e"; // emerald-500
const EDGE_EDIT_COLOR = "#22d3ee"; // cyan-400

// Lint issue discriminated union. Each issue points at one entity
// id so the LintPanel can click-to-jump straight into the right
// editor mode. The kinds map 1:1 to user-actionable fixes:
//   node-no-kind     → edit-node + set kind via dropdown
//   node-orphan      → edit-node + decide: assign kind / connect / delete
//   slope-detached   → select slope, drag an endpoint near a node
//   lift-detached    → select lift, drag an endpoint near a node
type LintIssue =
  | { kind: "node-no-kind"; nodeId: string }
  | { kind: "node-orphan"; nodeId: string }
  | { kind: "slope-detached"; slopeId: string }
  | { kind: "lift-detached"; liftId: string };

// Hard cap on the undo stack — anything older falls off the back.
// 20 covers any realistic editing session; if a user actually wants
// to roll back further, the rest-of-history is recoverable from the
// git commit produced by the prior PR.
const UNDO_DEPTH = 20;

// Frozen view of every override / added / deleted state at one point
// in time. Selection, mode, picks, and other UI-only state stay
// outside on purpose — undoing the user's last edit shouldn't also
// teleport the cursor or change which slope is highlighted.
type UndoSnapshot = {
  slopeOverrides: Record<string, SlopeOverride>;
  addedSlopes: SlopeRecord[];
  deletedSlopeIds: string[];
  liftOverrides: Record<string, LiftOverride>;
  addedLifts: LiftRecord[];
  deletedLiftIds: string[];
  placeOverride: Partial<PlaceRecord>;
  nodeOverrides: Record<string, Partial<GraphNode>>;
  addedGraphNodes: GraphNode[];
  deletedGraphNodeIds: string[];
  edgeOverrides: Record<string, EdgeOverride>;
  addedGraphEdges: GraphEdge[];
  deletedGraphEdgeIds: string[];
};

// Autosave: serialized snapshot + wall-clock at write time. Stored per
// resort under `osd-edit:draft:<country>/<region>/<slug>` so switching
// resorts doesn't trample drafts.
type StoredDraft = { snapshot: UndoSnapshot; savedAt: number };

const AUTOSAVE_DEBOUNCE_MS = 750;

function draftKey(ref: {
  slug: string;
  countryCode: string;
  regionSlug: string;
}): string {
  return `osd-edit:draft:${ref.countryCode}/${ref.regionSlug}/${ref.slug}`;
}

function isSnapshotEmpty(s: UndoSnapshot): boolean {
  return (
    Object.keys(s.slopeOverrides).length === 0 &&
    s.addedSlopes.length === 0 &&
    s.deletedSlopeIds.length === 0 &&
    Object.keys(s.liftOverrides).length === 0 &&
    s.addedLifts.length === 0 &&
    s.deletedLiftIds.length === 0 &&
    Object.keys(s.placeOverride).length === 0 &&
    Object.keys(s.nodeOverrides).length === 0 &&
    s.addedGraphNodes.length === 0 &&
    s.deletedGraphNodeIds.length === 0 &&
    Object.keys(s.edgeOverrides).length === 0 &&
    s.addedGraphEdges.length === 0 &&
    s.deletedGraphEdgeIds.length === 0
  );
}

// Conflict awareness: a pull request on upstream is "touching" this
// resort if its title contains the country/region/slug path the editor
// stamps into every commit message + PR title. That keeps the check
// to a single PR-list API call instead of an N+1 over per-PR file
// diffs. Match-by-title is good enough because the editor authors
// every relevant PR with `Edit <cc>/<region>/<slug>` or
// `Add <cc>/<region>/<slug>` shapes.
type ConflictInfo = {
  number: number;
  title: string;
  url: string;
  user: string;
};

async function fetchOpenPrsTouching(
  ref: { slug: string; countryCode: string; regionSlug: string },
  signal: AbortSignal,
): Promise<ConflictInfo[]> {
  // Unauthenticated GitHub REST: 60 req/hr per IP. For prod-scale
  // mass-collab traffic this should be fronted by a Cloudflare Pages
  // function that proxies with a server-side token (or short-TTL KV
  // cache). Tracked as a follow-up; rate-limit failures here are
  // silent because the badge is purely informational.
  const url = `https://api.github.com/repos/${UPSTREAM_OWNER}/${UPSTREAM_REPO}/pulls?state=open&per_page=100`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    signal,
  });
  if (!res.ok) return [];
  const prs = (await res.json()) as Array<{
    number: number;
    title: string;
    html_url: string;
    user: { login: string } | null;
  }>;
  if (!Array.isArray(prs)) return [];
  const slugPath = `${ref.countryCode}/${ref.regionSlug}/${ref.slug}`;
  return prs
    .filter((pr) => typeof pr.title === "string" && pr.title.includes(slugPath))
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      user: pr.user?.login ?? "unknown",
    }));
}

function formatRelativeTime(savedAt: number, locale: string): string {
  const diffMs = Math.max(0, Date.now() - savedAt);
  const fmt = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  // Sub-minute renders as seconds — EN "5 seconds ago" reads better
  // than "this minute" for fresh writes, and KO gets "5초 전".
  if (diffMs < 60_000) {
    const diffSec = Math.max(1, Math.round(diffMs / 1000));
    return fmt.format(-diffSec, "second");
  }
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 60) return fmt.format(-diffMin, "minute");
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return fmt.format(-diffH, "hour");
  const diffD = Math.round(diffH / 24);
  return fmt.format(-diffD, "day");
}

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

  // Cold-visit onboarding: shown on first visit; dismiss writes a
  // localStorage flag so repeat visits skip it. The "?" button in the
  // header force-reopens (sets welcomeOpen = true) for users who
  // dismissed and want to re-read the explainer.
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("osd-edit:welcome-seen") === "1") {
        setWelcomeOpen(false);
      }
    } catch {
      // localStorage may be disabled (private mode, cookies blocked) —
      // safe to keep showing the intro every time in that case.
    }
  }, []);
  const dismissWelcome = useCallback(() => {
    setWelcomeOpen(false);
    try {
      localStorage.setItem("osd-edit:welcome-seen", "1");
    } catch {}
  }, []);
  const reopenWelcome = useCallback(() => setWelcomeOpen(true), []);

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

  // edit-edge mode: which edge is being edited and per-baseline-edge
  // geometry overrides. Selection drives the editable polyline
  // treatment; overrides accumulate vertex drag/insert/delete
  // mutations the user makes during the session. Added-this-session
  // edges (addedGraphEdges) mutate in place instead — no override
  // map needed since they don't have a baseline to override.
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [edgeOverrides, setEdgeOverrides] = useState<
    Record<string, EdgeOverride>
  >({});

  // merge-close-nodes (step 6b): baseline-node deletions, baseline-
  // edge deletions (self-loops after rewire), and the pending merge
  // confirm UI. Added-this-session nodes/edges removed by merge get
  // dropped from their respective added* lists directly — no
  // tombstone needed.
  const [deletedGraphNodeIds, setDeletedGraphNodeIds] = useState<string[]>([]);
  const [deletedGraphEdgeIds, setDeletedGraphEdgeIds] = useState<string[]>([]);
  // Last-merge summary surfaced under the scan button so the user
  // sees "rewired N edges" feedback after each merge. null = nothing
  // merged yet this session.
  const [lastMergeRewired, setLastMergeRewired] = useState<number | null>(null);
  // null when there's no pair to confirm. Both ids are surfaced in
  // the prompt; `keepId` is canonicalised by the scanner (lower id
  // wins). distM is rounded to 1 decimal for display.
  const [mergePrompt, setMergePrompt] = useState<
    | { keepId: string; removeId: string; distM: number }
    | null
  >(null);

  // edit-node mode (step 7a): which node is being edited and per-
  // baseline-node overrides (kind, alt_m, position). Added-this-
  // session nodes mutate addedGraphNodes in place — no override map
  // since there's no baseline to override.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [nodeOverrides, setNodeOverrides] = useState<
    Record<string, Partial<GraphNode>>
  >({});

  // Entity browser: which tab is active and the live search string.
  const [activeEntityTab, setActiveEntityTab] = useState<
    "slopes" | "lifts" | "edges" | "nodes"
  >("slopes");
  const [entitySearch, setEntitySearch] = useState("");

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
    setSelectedEdgeId(null);
    setEdgeOverrides({});
    setDeletedGraphNodeIds([]);
    setDeletedGraphEdgeIds([]);
    setLastMergeRewired(null);
    setMergePrompt(null);
    setSelectedNodeId(null);
    setNodeOverrides({});
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
    if (id) {
      setSelectedLiftId(null);
      setActiveEntityTab("slopes");
      setEntitySearch("");
      const slope = effectiveSlopes.find((s) => s.id === id);
      const coords = slope?.coordinates;
      if (coords?.length) {
        const mid = coords[Math.floor(coords.length / 2)];
        googleMap.current?.panTo({ lat: mid.lat, lng: mid.lon });
      }
    }
  }
  function selectLift(id: string | null) {
    setSelectedLiftId(id);
    if (id) {
      setSelectedSlopeId(null);
      setActiveEntityTab("lifts");
      setEntitySearch("");
      const lift = effectiveLifts.find((l) => l.id === id);
      const coords = lift?.coordinates;
      if (coords?.length) {
        const mid = coords[Math.floor(coords.length / 2)];
        googleMap.current?.panTo({ lat: mid.lat, lng: mid.lon });
      }
    }
  }
  // Selecting an edge clears slope+lift so the right rail only ever
  // shows one entity. Symmetric with selectSlope/selectLift; gates
  // the edit-edge toolbar button (requiresSelection: "edge").
  function selectEdge(id: string | null) {
    setSelectedEdgeId(id);
    if (id) {
      setSelectedSlopeId(null);
      setSelectedLiftId(null);
      setSelectedNodeId(null);
      setActiveEntityTab("edges");
      setEntitySearch("");
      const edge =
        loadedResortRef.current?.graph?.edges.find((e) => e.id === id) ??
        addedGraphEdgesRef.current.find((e) => e.id === id);
      if (edge?.geometry.length) {
        const mid = edge.geometry[Math.floor(edge.geometry.length / 2)];
        googleMap.current?.panTo({ lat: mid.lat, lng: mid.lng });
      }
    }
  }
  // Selecting a node clears slope/lift/edge — same one-entity-at-a-
  // time rule. Gates the edit-node toolbar button (requiresSelection:
  // "node"). Used by the on-map click handler and NodesListPanel.
  function selectNode(id: string | null) {
    setSelectedNodeId(id);
    if (id) {
      setSelectedSlopeId(null);
      setSelectedLiftId(null);
      setSelectedEdgeId(null);
      setActiveEntityTab("nodes");
      setEntitySearch("");
      const node =
        loadedResortRef.current?.graph?.nodes.find((n) => n.id === id) ??
        addedGraphNodesRef.current.find((n) => n.id === id);
      if (node) {
        googleMap.current?.panTo({ lat: node.lat, lng: node.lng });
      }
    }
  }

  // When a node moves (drag or alt_m edit that changes coords),
  // every edge whose `from`/`to` references it needs its endpoint
  // geometry snapped to the new position. Preserves existing
  // edgeOverrides — merges the geometry patch into whatever's there.
  // Touches both baseline edges (via edgeOverrides) and added edges
  // (mutates addedGraphEdges).
  function applyNodeMove(
    nodeId: string,
    newLat: number,
    newLng: number,
    newAlt: number,
  ) {
    const resort = loadedResort;
    if (!resort?.graph) return;
    const endPos = { lat: newLat, lng: newLng, alt_m: newAlt };

    const deletedEdgeSet = new Set(deletedGraphEdgeIds);
    const baselinePatches: Record<string, EdgeOverride> = {};
    for (const e of resort.graph.edges) {
      if (deletedEdgeSet.has(e.id)) continue;
      const effective = edgeOverrides[e.id]
        ? { ...e, ...edgeOverrides[e.id] }
        : e;
      if (effective.from !== nodeId && effective.to !== nodeId) continue;
      let g = effective.geometry.slice();
      if (effective.from === nodeId) g = [endPos, ...g.slice(1)];
      if (effective.to === nodeId) g = [...g.slice(0, -1), endPos];
      baselinePatches[e.id] = { ...edgeOverrides[e.id], geometry: g };
    }
    if (Object.keys(baselinePatches).length > 0) {
      setEdgeOverrides((prev) => ({ ...prev, ...baselinePatches }));
    }

    let addedChanged = false;
    const newAdded = addedGraphEdges.map((e) => {
      if (e.from !== nodeId && e.to !== nodeId) return e;
      let g = e.geometry.slice();
      if (e.from === nodeId) g = [endPos, ...g.slice(1)];
      if (e.to === nodeId) g = [...g.slice(0, -1), endPos];
      addedChanged = true;
      return { ...e, geometry: g };
    });
    if (addedChanged) setAddedGraphEdges(newAdded);
  }

  // Standalone delete (step 7b). Removes a node and tombstones every
  // edge referencing it — there's no rewire here, since merge has
  // already covered the "join two nodes" use case. Baseline node →
  // deletedGraphNodeIds; added node → splice from addedGraphNodes.
  // Edges that referenced the node: baseline → deletedGraphEdgeIds;
  // added → splice from addedGraphEdges.
  function deleteNode(nodeId: string) {
    const resort = loadedResort;
    if (!resort?.graph) return;
    const isBaseline = resort.graph.nodes.some((n) => n.id === nodeId);
    const danglingBaselineEdgeIds = resort.graph.edges
      .filter((e) => e.from === nodeId || e.to === nodeId)
      .map((e) => e.id);
    if (danglingBaselineEdgeIds.length > 0) {
      setDeletedGraphEdgeIds((prev) =>
        Array.from(new Set([...prev, ...danglingBaselineEdgeIds])),
      );
    }
    setAddedGraphEdges((prev) =>
      prev.filter((e) => e.from !== nodeId && e.to !== nodeId),
    );
    if (isBaseline) {
      setDeletedGraphNodeIds((prev) =>
        prev.includes(nodeId) ? prev : [...prev, nodeId],
      );
    } else {
      setAddedGraphNodes((prev) => prev.filter((n) => n.id !== nodeId));
    }
    if (selectedNodeId === nodeId) setSelectedNodeId(null);
    if (
      selectedEdgeId !== null &&
      danglingBaselineEdgeIds.includes(selectedEdgeId)
    ) {
      setSelectedEdgeId(null);
    }
    // If we leave edit-node mode with no node, return to select so
    // the toolbar isn't sitting on a disabled mode.
    if (modeRef.current === "edit-node") setMode("select");
  }

  // Standalone edge delete (step 7b). Baseline → tombstone; added →
  // splice. Drops the selection if it pointed at this edge.
  function deleteEdge(edgeId: string) {
    const resort = loadedResort;
    if (!resort?.graph) return;
    const isBaseline = resort.graph.edges.some((e) => e.id === edgeId);
    if (isBaseline) {
      setDeletedGraphEdgeIds((prev) =>
        prev.includes(edgeId) ? prev : [...prev, edgeId],
      );
    } else {
      setAddedGraphEdges((prev) => prev.filter((e) => e.id !== edgeId));
    }
    if (selectedEdgeId === edgeId) setSelectedEdgeId(null);
    if (modeRef.current === "edit-edge") setMode("select");
  }

  // merge-close-nodes (step 6b). Scan all live nodes (baseline minus
  // deletedGraphNodeIds, plus addedGraphNodes) for the first pair
  // within MERGE_THRESHOLD_M of each other. Canonicalise so the
  // lower-id node is "kept" and the higher-id node is "removed".
  function findCloseNodePair(): {
    keepId: string;
    removeId: string;
    distM: number;
  } | null {
    const resort = loadedResort;
    if (!resort?.graph) return null;
    const deletedNodes = new Set(deletedGraphNodeIds);
    const liveNodes = [
      ...resort.graph.nodes.filter((n) => !deletedNodes.has(n.id)),
      ...addedGraphNodes,
    ];
    for (let i = 0; i < liveNodes.length; i++) {
      const a = liveNodes[i];
      for (let j = i + 1; j < liveNodes.length; j++) {
        const b = liveNodes[j];
        const d = distanceM(
          { lat: a.lat, lng: a.lng },
          { lat: b.lat, lng: b.lng },
        );
        if (d <= MERGE_THRESHOLD_M) {
          const keepId = a.id < b.id ? a.id : b.id;
          const removeId = a.id < b.id ? b.id : a.id;
          return { keepId, removeId, distM: d };
        }
      }
    }
    return null;
  }

  // Execute the merge: collapse `removeId` into `keepId`. For every
  // edge (baseline + added) that references removeId, rewire from/to
  // to keepId and snap the corresponding geometry endpoint to keep's
  // coords (so the rendered polyline actually meets the kept node).
  // Edges that become self-loops (from===to after rewire) are
  // dropped — added edges removed from the list, baseline edges
  // tombstoned in deletedGraphEdgeIds. Returns the rewire count so
  // the UI can surface "Rewired N edges" feedback.
  function mergeNodes(
    keepId: string,
    removeId: string,
  ): { rewired: number } {
    const resort = loadedResort;
    if (!resort?.graph) return { rewired: 0 };
    const allNodes = [...resort.graph.nodes, ...addedGraphNodes];
    const keepNode = allNodes.find((n) => n.id === keepId);
    const removeNode = allNodes.find((n) => n.id === removeId);
    if (!keepNode || !removeNode) return { rewired: 0 };

    // Geometry convention from the schema: when edge.from === X, the
    // edge's first geometry vertex sits at X; when edge.to === X, the
    // last vertex sits at X. Rewire by swapping the corresponding
    // endpoint to keep's coords.
    const swapEndpoint = (e: GraphEdge): GraphEdge => {
      let newFrom = e.from;
      let newTo = e.to;
      let newGeom = e.geometry.slice();
      const keepPos = {
        lat: keepNode.lat,
        lng: keepNode.lng,
        alt_m: keepNode.alt_m,
      };
      if (e.from === removeId) {
        newFrom = keepId;
        newGeom = [keepPos, ...newGeom.slice(1)];
      }
      if (e.to === removeId) {
        newTo = keepId;
        newGeom = [...newGeom.slice(0, -1), keepPos];
      }
      return { ...e, from: newFrom, to: newTo, geometry: newGeom };
    };

    let rewired = 0;
    const newBaselineDeletedEdgeIds: string[] = [];
    const newBaselineEdgeOverrides: Record<string, EdgeOverride> = {};
    for (const e of resort.graph.edges) {
      if (e.from !== removeId && e.to !== removeId) continue;
      const effective = edgeOverrides[e.id]
        ? { ...e, ...edgeOverrides[e.id] }
        : e;
      const swapped = swapEndpoint(effective);
      if (swapped.from === swapped.to) {
        newBaselineDeletedEdgeIds.push(e.id);
      } else {
        newBaselineEdgeOverrides[e.id] = {
          from: swapped.from,
          to: swapped.to,
          geometry: swapped.geometry,
        };
        rewired += 1;
      }
    }

    const newAddedEdges: GraphEdge[] = [];
    for (const e of addedGraphEdges) {
      if (e.from !== removeId && e.to !== removeId) {
        newAddedEdges.push(e);
        continue;
      }
      const swapped = swapEndpoint(e);
      if (swapped.from === swapped.to) continue;
      newAddedEdges.push(swapped);
      rewired += 1;
    }

    if (Object.keys(newBaselineEdgeOverrides).length > 0) {
      setEdgeOverrides((prev) => ({ ...prev, ...newBaselineEdgeOverrides }));
    }
    if (newBaselineDeletedEdgeIds.length > 0) {
      setDeletedGraphEdgeIds((prev) =>
        Array.from(new Set([...prev, ...newBaselineDeletedEdgeIds])),
      );
    }
    if (newAddedEdges.length !== addedGraphEdges.length) {
      setAddedGraphEdges(newAddedEdges);
    } else if (
      newAddedEdges.some((e, i) => e !== addedGraphEdges[i])
    ) {
      setAddedGraphEdges(newAddedEdges);
    }

    // Drop the removed node. Baseline → tombstone; added → splice out.
    const isBaselineNode = resort.graph.nodes.some((n) => n.id === removeId);
    if (isBaselineNode) {
      setDeletedGraphNodeIds((prev) =>
        prev.includes(removeId) ? prev : [...prev, removeId],
      );
    } else {
      setAddedGraphNodes((prev) => prev.filter((n) => n.id !== removeId));
    }
    // If the selected edge got tombstoned, drop the selection so the
    // edit-edge panel doesn't dangle.
    if (
      selectedEdgeId !== null &&
      newBaselineDeletedEdgeIds.includes(selectedEdgeId)
    ) {
      setSelectedEdgeId(null);
    }

    return { rewired };
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

  // Live lint pass (step 8a). Re-runs on every state change that
  // could resolve or introduce an issue. The four checks are cheap
  // (O(N) over nodes/edges + O(slopes × nodes) bounded distance
  // probes); alpensia exercises ~70 slopes × 100 nodes so this stays
  // well under a millisecond.
  const lintIssues = useMemo<LintIssue[]>(() => {
    if (!loadedResort?.graph) return [];
    const tombstonedNodes = new Set(deletedGraphNodeIds);
    const tombstonedEdges = new Set(deletedGraphEdgeIds);
    const baselineNodes = loadedResort.graph.nodes
      .filter((n) => !tombstonedNodes.has(n.id))
      .map((n) => {
        const ov = nodeOverrides[n.id];
        return ov ? { ...n, ...ov } : n;
      });
    const liveNodes = [...baselineNodes, ...addedGraphNodes];
    const baselineEdges = loadedResort.graph.edges
      .filter((e) => !tombstonedEdges.has(e.id))
      .map((e) => {
        const ov = edgeOverrides[e.id];
        return ov ? { ...e, ...ov } : e;
      });
    const liveEdges = [...baselineEdges, ...addedGraphEdges];

    const issues: LintIssue[] = [];

    for (const n of liveNodes) {
      if (!n.kind) issues.push({ kind: "node-no-kind", nodeId: n.id });
    }

    const referencedNodes = new Set<string>();
    for (const e of liveEdges) {
      referencedNodes.add(e.from);
      referencedNodes.add(e.to);
    }
    for (const n of liveNodes) {
      if (!referencedNodes.has(n.id)) {
        issues.push({ kind: "node-orphan", nodeId: n.id });
      }
    }

    const isDetached = (
      coords: { lat: number; lon: number }[] | undefined,
    ): boolean => {
      if (!coords || coords.length < 2) return false;
      const head = { lat: coords[0].lat, lng: coords[0].lon };
      const tail = {
        lat: coords[coords.length - 1].lat,
        lng: coords[coords.length - 1].lon,
      };
      for (const n of liveNodes) {
        const target = { lat: n.lat, lng: n.lng };
        if (distanceM(head, target) <= LINT_DETACH_RADIUS_M) return false;
        if (distanceM(tail, target) <= LINT_DETACH_RADIUS_M) return false;
      }
      return true;
    };

    for (const s of effectiveSlopes) {
      if (isDetached(s.coordinates)) {
        issues.push({ kind: "slope-detached", slopeId: s.id });
      }
    }
    for (const l of effectiveLifts) {
      if (isDetached(l.coordinates)) {
        issues.push({ kind: "lift-detached", liftId: l.id });
      }
    }

    return issues;
  }, [
    loadedResort,
    deletedGraphNodeIds,
    deletedGraphEdgeIds,
    nodeOverrides,
    edgeOverrides,
    addedGraphNodes,
    addedGraphEdges,
    effectiveSlopes,
    effectiveLifts,
  ]);

  function jumpToLintIssue(issue: LintIssue) {
    if (issue.kind === "node-no-kind" || issue.kind === "node-orphan") {
      selectNode(issue.nodeId);
      setMode("edit-node");
    } else if (issue.kind === "slope-detached") {
      selectSlope(issue.slopeId);
      setMode("select");
    } else if (issue.kind === "lift-detached") {
      selectLift(issue.liftId);
      setMode("select");
    }
  }

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

    const graphMode =
      mode === "add-node" ||
      mode === "connect-nodes" ||
      mode === "edit-edge" ||
      mode === "edit-node" ||
      mode === "select";
    if (!graphMode) return;
    if (!loadedResort) return;

    const isConnect = mode === "connect-nodes";
    const isEditNode = mode === "edit-node";
    const isSelectMode = mode === "select";
    const deletedSet = new Set(deletedGraphNodeIds);
    // Apply nodeOverrides to baseline nodes so dragged-then-deselected
    // positions persist after the user leaves edit-node mode.
    const existing = (loadedResort.graph?.nodes ?? [])
      .filter((n) => !deletedSet.has(n.id))
      .map((n) => {
        const ov = nodeOverrides[n.id];
        return ov ? { ...n, ...ov } : n;
      });

    for (const n of existing) {
      const isPending = anchorNodeId === n.id;
      const isSelectedNode = selectedNodeId === n.id;
      const draggable = isEditNode && isSelectedNode;
      const baseColor = isPending
        ? "#facc15"
        : isSelectedNode
          ? "#22d3ee"
          : "#64748b";
      const marker = new google.maps.Marker({
        position: { lat: n.lat, lng: n.lng },
        map,
        draggable,
        title: `node ${n.id}${n.kind ? ` · ${n.kind}` : ""} · ${n.alt_m.toFixed(0)}m`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          // Bump scale in connect-nodes mode so existing nodes are
          // easier to hit. Pending-from / selected get larger.
          scale: isPending || isSelectedNode ? 9 : isConnect ? 6 : 4,
          fillColor: baseColor,
          fillOpacity: isPending || isSelectedNode ? 1 : 0.85,
          strokeColor: "#ffffff",
          strokeWeight: isPending || isSelectedNode ? 2 : 1,
        },
        zIndex: isSelectedNode ? 50 : isPending ? 40 : 10,
      });
      if (isConnect) {
        marker.addListener("click", () => pickConnectNodeRef.current(n.id));
      } else if (isEditNode || isSelectMode) {
        marker.addListener("click", () => selectNode(n.id));
      }
      if (draggable) {
        marker.addListener("dragend", (ev: google.maps.MapMouseEvent) => {
          if (!ev.latLng) return;
          const lat = ev.latLng.lat();
          const lng = ev.latLng.lng();
          const alt = n.alt_m;
          setNodeOverrides((prev) => ({
            ...prev,
            [n.id]: { ...prev[n.id], lat, lng },
          }));
          applyNodeMove(n.id, lat, lng, alt);
        });
      }
      graphNodeMarkersRef.current.push(marker);
    }

    for (const n of addedGraphNodes) {
      const isPending = anchorNodeId === n.id;
      const isSelectedNode = selectedNodeId === n.id;
      const draggable = isEditNode && isSelectedNode;
      const marker = new google.maps.Marker({
        position: { lat: n.lat, lng: n.lng },
        map,
        draggable,
        title: isConnect
          ? `new node ${n.id} — click to ${isPending ? "cancel" : "connect"}`
          : `new node ${n.id}${n.kind ? ` · ${n.kind}` : ""} · ${n.alt_m.toFixed(0)}m`,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: isPending || isSelectedNode ? 9 : 7,
          fillColor: isPending
            ? "#facc15"
            : isSelectedNode
              ? "#22d3ee"
              : "#22c55e", // yellow / cyan / emerald
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
        },
        zIndex: isSelectedNode ? 50 : isPending ? 40 : 20,
      });
      if (isConnect) {
        marker.addListener("click", () => pickConnectNodeRef.current(n.id));
      } else if (isEditNode || isSelectMode) {
        marker.addListener("click", () => selectNode(n.id));
        // add-node mode also keeps the right-click-remove gesture for
        // newly-dropped nodes, restored below.
      } else if (mode === "add-node") {
        marker.addListener("rightclick", () => {
          setAddedGraphNodes((prev) => prev.filter((x) => x.id !== n.id));
        });
      }
      if (draggable) {
        marker.addListener("dragend", (ev: google.maps.MapMouseEvent) => {
          if (!ev.latLng) return;
          const lat = ev.latLng.lat();
          const lng = ev.latLng.lng();
          const alt = n.alt_m;
          setAddedGraphNodes((prev) =>
            prev.map((x) => (x.id === n.id ? { ...x, lat, lng } : x)),
          );
          applyNodeMove(n.id, lat, lng, alt);
        });
      }
      graphNodeMarkersRef.current.push(marker);
    }
  }, [
    mode,
    mapReady,
    loadedResort,
    addedGraphNodes,
    anchorNodeId,
    deletedGraphNodeIds,
    selectedNodeId,
    nodeOverrides,
  ]);

  // ── Graph edges overlay (select + connect-nodes + edit-edge) ──
  //
  // Renders existing edges in dim slate, session-added edges in
  // emerald, and the currently-selected edge in cyan with Google
  // Maps' built-in editable handles (drag vertex, drag midpoint to
  // insert, right-click vertex to delete). Path mutations sync into
  // edgeOverrides (baseline edges) or addedGraphEdges (session
  // edges) so the patch bundle picks them up.
  //
  // Edges are clickable in `select` and `edit-edge` modes — the
  // panel-list pick is the primary entry point, but click-on-line
  // also works once the user knows the gesture exists.
  const graphEdgeLinesRef = useRef<google.maps.Polyline[]>([]);
  useEffect(() => {
    const map = googleMap.current;
    if (!map) return;
    graphEdgeLinesRef.current.forEach((p) => p.setMap(null));
    graphEdgeLinesRef.current = [];

    const showEdges =
      mode === "connect-nodes" || mode === "edit-edge" || mode === "select";
    if (!showEdges || !loadedResort) return;

    // Baseline edges with per-edge overrides applied. The override's
    // `geometry` (when present) is the source of truth for the
    // polyline path; anything else (from/to/kind) flows through too.
    // Tombstoned edges (deletedGraphEdgeIds — self-loops post-merge)
    // are filtered out so the rendered map matches what patchBundle
    // will emit.
    const tombstonedEdgeSet = new Set(deletedGraphEdgeIds);
    const baselineEdges = (loadedResort.graph?.edges ?? [])
      .filter((e) => !tombstonedEdgeSet.has(e.id))
      .map((e) => {
        const ov = edgeOverrides[e.id];
        return ov ? { ...e, ...ov } : e;
      });

    const renderEdge = (e: GraphEdge, isAdded: boolean) => {
      const isSelected = e.id === selectedEdgeId;
      const isEditing = isSelected && mode === "edit-edge";
      const path = e.geometry.map((p) => ({ lat: p.lat, lng: p.lng }));
      const line = new google.maps.Polyline({
        map,
        path,
        strokeColor: isEditing
          ? EDGE_EDIT_COLOR
          : isAdded
            ? EDGE_ADDED_COLOR
            : EDGE_BASELINE_COLOR,
        strokeOpacity: isEditing ? 1 : isAdded ? 0.95 : isSelected ? 0.9 : 0.55,
        strokeWeight: isEditing ? 4 : isSelected ? 3 : isAdded ? 3 : 2,
        clickable: true,
        editable: isEditing,
        zIndex: isEditing ? 30 : isAdded ? 20 : 10,
      });
      line.addListener("click", () => {
        const m = modeRef.current;
        if (m === "select" || m === "edit-edge") {
          selectEdge(e.id);
        }
      });
      if (isEditing) {
        // Mirror path mutations back into the right store. set_at /
        // insert_at / remove_at cover drag, midpoint-insert, and
        // right-click-delete. Inserted vertices interpolate alt_m
        // from the neighbour with the smaller index (cheap, keeps the
        // schema satisfied; user can refine via /api/elevation in a
        // later commit if needed).
        //
        // Guard: when the Maps API key is restricted (e.g.
        // RefererNotAllowedMapError on localhost), getPath() can
        // throw or return undefined. Skip the sync wiring in that
        // case so a broken key doesn't crash the editor tree.
        let livePath: google.maps.MVCArray<google.maps.LatLng> | undefined;
        try {
          livePath = line.getPath();
        } catch {
          livePath = undefined;
        }
        if (!livePath) {
          graphEdgeLinesRef.current.push(line);
          return;
        }
        const sync = () => {
          const arr = livePath.getArray();
          const oldGeom = e.geometry;
          const nextGeom: GraphEdge["geometry"] = arr.map((p, i) => {
            const lat = p.lat();
            const lng = p.lng();
            // Try to preserve the original alt_m by matching positions
            // against the baseline edge geometry — drag mutations
            // preserve indices, only inserts/removes shift them. If
            // the position matches an old vertex, reuse its alt_m;
            // otherwise interpolate from neighbours.
            const match = oldGeom.find(
              (g) =>
                Math.abs(g.lat - lat) < 1e-9 && Math.abs(g.lng - lng) < 1e-9,
            );
            if (match) return { lat, lng, alt_m: match.alt_m };
            // Interpolate from the inserted vertex's neighbours in
            // the NEW array — they're either old (with alt_m) or
            // freshly inserted (rare cascade; fall back to 0).
            const prev = i > 0 ? arr[i - 1] : null;
            const next = i < arr.length - 1 ? arr[i + 1] : null;
            const altOf = (g: google.maps.LatLng | null) => {
              if (!g) return null;
              const m = oldGeom.find(
                (v) =>
                  Math.abs(v.lat - g.lat()) < 1e-9 &&
                  Math.abs(v.lng - g.lng()) < 1e-9,
              );
              return m?.alt_m ?? null;
            };
            const prevAlt = altOf(prev);
            const nextAlt = altOf(next);
            const alt_m =
              prevAlt !== null && nextAlt !== null
                ? (prevAlt + nextAlt) / 2
                : (prevAlt ?? nextAlt ?? 0);
            return { lat, lng, alt_m };
          });
          if (isAdded) {
            setAddedGraphEdges((prev) =>
              prev.map((x) => (x.id === e.id ? { ...x, geometry: nextGeom } : x)),
            );
          } else {
            setEdgeOverrides((prev) => ({
              ...prev,
              [e.id]: { ...prev[e.id], geometry: nextGeom },
            }));
          }
        };
        google.maps.event.addListener(livePath, "set_at", sync);
        google.maps.event.addListener(livePath, "insert_at", sync);
        google.maps.event.addListener(livePath, "remove_at", sync);
      }
      graphEdgeLinesRef.current.push(line);
    };

    for (const e of baselineEdges) renderEdge(e, false);
    for (const e of addedGraphEdges) renderEdge(e, true);
  }, [
    mode,
    mapReady,
    loadedResort,
    addedGraphEdges,
    edgeOverrides,
    selectedEdgeId,
    deletedGraphEdgeIds,
  ]);

  // Esc cancels the pending "from" node in connect-nodes mode, OR
  // drops the edge selection in edit-edge mode (which also flips the
  // toolbar back to a state where edit-edge is disabled). Cleared
  // automatically when the user leaves connect-nodes (handled in the
  // mode-change effect below); edit-edge selection is sticky so the
  // user can switch between select and edit-edge without losing it.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const m = modeRef.current;
      if (e.key !== "Escape") return;
      if (m === "connect-nodes") {
        e.preventDefault();
        setAnchorNodeId(null);
      } else if (m === "edit-edge") {
        e.preventDefault();
        setSelectedEdgeId(null);
        setMode("select");
      } else if (m === "edit-node") {
        e.preventDefault();
        setSelectedNodeId(null);
        setMode("select");
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
    const graphEdgesEdited = Object.keys(edgeOverrides).length;
    const graphNodesDeleted = deletedGraphNodeIds.length;
    const graphEdgesDeleted = deletedGraphEdgeIds.length;
    const graphNodesEdited = Object.keys(nodeOverrides).length;
    if (
      slopeEdits + slopeAdded + slopeDeleted +
      liftEdits + liftAdded + liftDeleted +
      placeEdits + graphNodesAdded + graphEdgesAdded + graphEdgesEdited +
      graphNodesDeleted + graphEdgesDeleted + graphNodesEdited === 0
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
    // graph = (existing.nodes − deletedGraphNodeIds) ++ addedGraphNodes,
    // edges = (baseline-with-overrides − deletedGraphEdgeIds) ++
    // addedGraphEdges. snap_config pass-through preserved.
    if (
      (graphNodesAdded > 0 ||
        graphEdgesAdded > 0 ||
        graphEdgesEdited > 0 ||
        graphNodesDeleted > 0 ||
        graphEdgesDeleted > 0 ||
        graphNodesEdited > 0) &&
      loadedResort.graph
    ) {
      const deletedNodeSet = new Set(deletedGraphNodeIds);
      const deletedEdgeSet = new Set(deletedGraphEdgeIds);
      const keptBaselineNodes = loadedResort.graph.nodes
        .filter((n) => !deletedNodeSet.has(n.id))
        .map((n) => {
          const ov = nodeOverrides[n.id];
          return ov ? { ...n, ...ov } : n;
        });
      const editedBaselineEdges = loadedResort.graph.edges
        .filter((e) => !deletedEdgeSet.has(e.id))
        .map((e) => {
          const ov = edgeOverrides[e.id];
          return ov ? { ...e, ...ov } : e;
        });
      const merged: SlopeGraphRecord = {
        ...loadedResort.graph,
        nodes: [...keptBaselineNodes, ...addedGraphNodes],
        edges: [...editedBaselineEdges, ...addedGraphEdges],
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
    if (graphEdgesEdited > 0)
      parts.push(`edit ${graphEdgesEdited} graph edge${graphEdgesEdited === 1 ? "" : "s"}`);
    if (graphNodesDeleted > 0)
      parts.push(`delete ${graphNodesDeleted} graph node${graphNodesDeleted === 1 ? "" : "s"}`);
    if (graphEdgesDeleted > 0)
      parts.push(`delete ${graphEdgesDeleted} graph edge${graphEdgesDeleted === 1 ? "" : "s"}`);
    if (graphNodesEdited > 0)
      parts.push(`edit ${graphNodesEdited} graph node${graphNodesEdited === 1 ? "" : "s"}`);

    return {
      slug: loadedResort.ref.slug,
      countryCode: loadedResort.ref.countryCode,
      regionSlug: loadedResort.ref.regionSlug,
      files,
      message: `slope-author-2: ${parts.join(" + ")}`,
    };
  }, [loadedResort, slopeOverrides, addedSlopes, deletedSlopeIds, liftOverrides, addedLifts, deletedLiftIds, placeOverride, effectivePlace, sessionUser?.login, addedGraphNodes, addedGraphEdges, edgeOverrides, deletedGraphNodeIds, deletedGraphEdgeIds, nodeOverrides]);

  // ── Undo stack ────────────────────────────────────────────────
  //
  // Snapshot-based undo. The 13 mutation states form an
  // `UndoSnapshot`; whenever any of them changes (detected via
  // useMemo + useEffect over their refs), the PRIOR snapshot is
  // pushed onto the stack. `undo()` pops the top and replays it
  // through every setter. Selection / mode / picks are deliberately
  // outside the snapshot — they're UI state, not edits.
  //
  // No-recapture trick: before calling the 13 setters, we pre-set
  // `lastSnapshotRef` to the snapshot we're restoring. After the
  // setters resolve, useMemo recomputes currentSnapshot with refs
  // matching `lastSnapshotRef` and the equality short-circuit fires,
  // so the restore itself doesn't generate a fresh undo entry.
  const currentSnapshot = useMemo(
    () => ({
      slopeOverrides,
      addedSlopes,
      deletedSlopeIds,
      liftOverrides,
      addedLifts,
      deletedLiftIds,
      placeOverride,
      nodeOverrides,
      addedGraphNodes,
      deletedGraphNodeIds,
      edgeOverrides,
      addedGraphEdges,
      deletedGraphEdgeIds,
    }),
    [
      slopeOverrides,
      addedSlopes,
      deletedSlopeIds,
      liftOverrides,
      addedLifts,
      deletedLiftIds,
      placeOverride,
      nodeOverrides,
      addedGraphNodes,
      deletedGraphNodeIds,
      edgeOverrides,
      addedGraphEdges,
      deletedGraphEdgeIds,
    ],
  );
  const [undoStack, setUndoStack] = useState<UndoSnapshot[]>([]);
  const lastSnapshotRef = useRef<UndoSnapshot | null>(null);
  useEffect(() => {
    if (lastSnapshotRef.current === null) {
      lastSnapshotRef.current = currentSnapshot;
      return;
    }
    const prior = lastSnapshotRef.current;
    if (
      prior.slopeOverrides === currentSnapshot.slopeOverrides &&
      prior.addedSlopes === currentSnapshot.addedSlopes &&
      prior.deletedSlopeIds === currentSnapshot.deletedSlopeIds &&
      prior.liftOverrides === currentSnapshot.liftOverrides &&
      prior.addedLifts === currentSnapshot.addedLifts &&
      prior.deletedLiftIds === currentSnapshot.deletedLiftIds &&
      prior.placeOverride === currentSnapshot.placeOverride &&
      prior.nodeOverrides === currentSnapshot.nodeOverrides &&
      prior.addedGraphNodes === currentSnapshot.addedGraphNodes &&
      prior.deletedGraphNodeIds === currentSnapshot.deletedGraphNodeIds &&
      prior.edgeOverrides === currentSnapshot.edgeOverrides &&
      prior.addedGraphEdges === currentSnapshot.addedGraphEdges &&
      prior.deletedGraphEdgeIds === currentSnapshot.deletedGraphEdgeIds
    ) {
      return;
    }
    setUndoStack((stack) => [...stack.slice(-(UNDO_DEPTH - 1)), prior]);
    lastSnapshotRef.current = currentSnapshot;
  }, [currentSnapshot]);

  // Whenever the loaded resort changes (initial load or switch), drop
  // the undo stack AND reset lastSnapshotRef. Resetting the ref is
  // load-bearing: the reset useEffect at the top of the component
  // wipes all 13 mutation states to fresh empty objects on slug
  // change, and ref-equality would otherwise fire the tracker on the
  // next render and push a phantom "pre-load" snapshot onto the
  // freshly-cleared stack. Nulling the ref makes the next tracker
  // tick re-initialize from the post-reset state instead.
  //
  // Also re-arms the autosave guards so the restore-check effect can
  // read the new resort's draft before the autosave-write effect has
  // a chance to wipe it during the post-reset empty-snapshot tick.
  const [hasSavedDraft, setHasSavedDraft] = useState<StoredDraft | null>(null);
  const pendingRestoreCheckRef = useRef<boolean>(true);
  useEffect(() => {
    setUndoStack([]);
    lastSnapshotRef.current = null;
    setHasSavedDraft(null);
    pendingRestoreCheckRef.current = true;
  }, [loadedResort?.ref.slug]);

  // Read a draft (if any) for the freshly-loaded resort and offer it
  // up via the RestoreBanner. Empty drafts get cleaned up silently.
  useEffect(() => {
    if (!loadedResort) {
      pendingRestoreCheckRef.current = false;
      return;
    }
    try {
      const key = draftKey(loadedResort.ref);
      const raw = localStorage.getItem(key);
      if (!raw) return;
      const parsed = JSON.parse(raw) as StoredDraft;
      if (
        !parsed ||
        typeof parsed.savedAt !== "number" ||
        !parsed.snapshot ||
        isSnapshotEmpty(parsed.snapshot)
      ) {
        try {
          localStorage.removeItem(key);
        } catch {}
        return;
      }
      setHasSavedDraft(parsed);
    } catch {
      // Best-effort: corrupted JSON / disabled storage shouldn't
      // break loading.
    } finally {
      pendingRestoreCheckRef.current = false;
    }
  }, [loadedResort?.ref.slug, loadedResort]);

  // Debounced autosave-write. Guards:
  //   - skip while the restore-check is still pending (the empty
  //     post-reset snapshot would otherwise erase the very key we're
  //     about to read)
  //   - skip while a RestoreBanner is unresolved (don't trample the
  //     draft the user hasn't accepted/discarded yet)
  //   - empty snapshot → remove the key instead of writing it (keeps
  //     the storage tidy and avoids re-prompting on the next visit)
  useEffect(() => {
    if (pendingRestoreCheckRef.current) return;
    if (!loadedResort) return;
    if (hasSavedDraft) return;
    const key = draftKey(loadedResort.ref);
    if (isSnapshotEmpty(currentSnapshot)) {
      try {
        localStorage.removeItem(key);
      } catch {}
      return;
    }
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(
          key,
          JSON.stringify({
            snapshot: currentSnapshot,
            savedAt: Date.now(),
          } satisfies StoredDraft),
        );
      } catch {
        // Quota / private-mode failures are non-fatal — the user
        // still has the in-memory edits.
      }
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [currentSnapshot, loadedResort, hasSavedDraft]);

  const restoreDraft = useCallback(() => {
    setHasSavedDraft((current) => {
      if (!current) return null;
      const s = current.snapshot;
      // Same no-recapture trick as undo() — pre-set the tracker ref
      // so the ref-equality short-circuit fires and the restored
      // state doesn't produce a phantom undo entry.
      lastSnapshotRef.current = s;
      setSlopeOverrides(s.slopeOverrides);
      setAddedSlopes(s.addedSlopes);
      setDeletedSlopeIds(s.deletedSlopeIds);
      setLiftOverrides(s.liftOverrides);
      setAddedLifts(s.addedLifts);
      setDeletedLiftIds(s.deletedLiftIds);
      setPlaceOverride(s.placeOverride);
      setNodeOverrides(s.nodeOverrides);
      setAddedGraphNodes(s.addedGraphNodes);
      setDeletedGraphNodeIds(s.deletedGraphNodeIds);
      setEdgeOverrides(s.edgeOverrides);
      setAddedGraphEdges(s.addedGraphEdges);
      setDeletedGraphEdgeIds(s.deletedGraphEdgeIds);
      return null;
    });
  }, []);

  const discardDraft = useCallback(() => {
    if (loadedResort) {
      try {
        localStorage.removeItem(draftKey(loadedResort.ref));
      } catch {}
    }
    setHasSavedDraft(null);
  }, [loadedResort]);

  // Conflict-awareness: query upstream open PRs whose title matches
  // the current resort. Fires once per resort load; debounced via the
  // AbortController so rapid resort-switching cancels in-flight calls.
  const [conflicts, setConflicts] = useState<ConflictInfo[]>([]);
  useEffect(() => {
    if (!loadedResort) {
      setConflicts([]);
      return;
    }
    const controller = new AbortController();
    fetchOpenPrsTouching(loadedResort.ref, controller.signal)
      .then((found) => {
        if (controller.signal.aborted) return;
        setConflicts(found);
      })
      .catch(() => {
        // AbortError on resort switch + network/rate-limit failures
        // are non-fatal — the badge is purely informational.
        if (!controller.signal.aborted) setConflicts([]);
      });
    return () => controller.abort();
  }, [loadedResort?.ref.slug, loadedResort?.ref.countryCode, loadedResort?.ref.regionSlug]);

  const undo = useCallback(() => {
    setUndoStack((stack) => {
      if (stack.length === 0) return stack;
      const prior = stack[stack.length - 1];
      lastSnapshotRef.current = prior;
      setSlopeOverrides(prior.slopeOverrides);
      setAddedSlopes(prior.addedSlopes);
      setDeletedSlopeIds(prior.deletedSlopeIds);
      setLiftOverrides(prior.liftOverrides);
      setAddedLifts(prior.addedLifts);
      setDeletedLiftIds(prior.deletedLiftIds);
      setPlaceOverride(prior.placeOverride);
      setNodeOverrides(prior.nodeOverrides);
      setAddedGraphNodes(prior.addedGraphNodes);
      setDeletedGraphNodeIds(prior.deletedGraphNodeIds);
      setEdgeOverrides(prior.edgeOverrides);
      setAddedGraphEdges(prior.addedGraphEdges);
      setDeletedGraphEdgeIds(prior.deletedGraphEdgeIds);
      return stack.slice(0, -1);
    });
  }, []);

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
    <section className="relative h-[100dvh] w-full overflow-hidden bg-[#071521] text-[var(--fg)]">
      {/* ── Map canvas — full viewport, all chrome floats over it ── */}
      <div className="absolute inset-0">
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
      </div>

      {/* ── Floating header — compact pill on mobile, wider card on desktop ── */}
      <header className="pointer-events-none absolute left-4 top-4 z-20 md:w-[22rem]">
        <div className="pointer-events-auto flex items-center justify-between gap-3 rounded-2xl border border-white/5 bg-[var(--bg-glass)] px-3 py-2 shadow-[var(--shadow-glass)] backdrop-blur-md md:px-4 md:py-2.5">
          <div className="min-w-0">
            {/* Eyebrow hidden on mobile — saves header height */}
            <p className="hidden text-[9px] font-semibold text-[var(--accent-soft)] md:block">
              {t("devEyebrow")}
            </p>
            <h1 className="truncate text-xs font-bold md:text-sm">{t("title")}</h1>
          </div>
          <div className="flex flex-none items-center gap-1.5 text-xs">
            <button
              type="button"
              data-testid="welcome-help"
              onClick={reopenWelcome}
              aria-label={t("welcomeHelpLabel")}
              title={t("welcomeHelpLabel")}
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white/10 text-[11px] font-bold text-[var(--fg-muted)] transition hover:bg-white/20 hover:text-[var(--fg)]"
            >
              ?
            </button>
            <Link
              href="/settings"
              aria-label="Settings"
              title="Settings"
              className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-white/10 text-[13px] text-[var(--fg-muted)] transition hover:bg-white/20 hover:text-[var(--fg)]"
            >
              ⚙
            </Link>
          </div>
        </div>
      </header>

      {/* ── Mode dock — top-center pill on mobile, bottom-left card on desktop ──
           Mobile: sits just below the header chip at top-14, always visible
           regardless of the drawer state. Icon-only pill keeps it compact.
           Desktop: glass card bottom-left, unchanged. */}
      <div className="pointer-events-none absolute left-0 right-0 top-14 z-20 flex justify-center md:bottom-10 md:left-4 md:right-auto md:top-auto md:block">
        <div className="pointer-events-auto">
          <ModeToolbar
            mode={mode}
            onModeChange={setMode}
            hasSlope={selectedSlopeId !== null}
            hasLift={selectedLiftId !== null}
            hasEdge={selectedEdgeId !== null}
            hasNode={selectedNodeId !== null}
          />
        </div>
      </div>

      {/* ── Right rail / mobile drawer ── */}
      <aside
        data-mobile-sheet
        className={`pointer-events-auto flex w-full flex-none flex-col overflow-hidden bg-[var(--bg-elev)] shadow-[var(--shadow-glass)] md:bg-[var(--bg-glass)] md:backdrop-blur-md transition-[max-height] duration-200 ease-out fixed bottom-0 left-0 right-0 z-30 rounded-t-3xl border-t border-white/10 ${drawerMaxH} md:absolute md:bottom-4 md:left-auto md:right-4 md:top-[64px] md:z-20 md:max-h-[calc(100dvh-80px)] md:w-[22rem] md:rounded-2xl md:border md:border-white/5 md:transition-none`}
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
            className="flex w-full flex-none flex-col items-center gap-1 border-b border-[var(--border)] bg-[var(--bg-elev)] px-3 py-2 transition hover:bg-[var(--bg-elev-strong)] md:hidden"
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
            <WelcomeIntro open={welcomeOpen} onDismiss={dismissWelcome} />

            <ResortLoader onLoad={setLoadedResort} />

            <ConflictBadge conflicts={conflicts} />

            {hasSavedDraft && (
              <RestoreBanner
                draft={hasSavedDraft}
                onRestore={restoreDraft}
                onDiscard={discardDraft}
              />
            )}

            <UndoBar depth={undoStack.length} onUndo={undo} />

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

            {/* ── Entity browser: tabs + search + contained list ── */}
            {loadedResort && (
              <EntityBrowserPanel
                activeTab={activeEntityTab}
                onTabChange={setActiveEntityTab}
                search={entitySearch}
                onSearchChange={setEntitySearch}
                selectedId={
                  selectedSlopeId ??
                  selectedLiftId ??
                  selectedEdgeId ??
                  selectedNodeId
                }
                slopes={effectiveSlopes}
                lifts={effectiveLifts}
                baselineEdges={
                  loadedResort.graph?.edges.filter(
                    (e) => !deletedGraphEdgeIds.includes(e.id),
                  ) ?? []
                }
                addedEdges={addedGraphEdges}
                edgeOverrides={edgeOverrides}
                baselineNodes={
                  loadedResort.graph?.nodes.filter(
                    (n) => !deletedGraphNodeIds.includes(n.id),
                  ) ?? []
                }
                addedNodes={addedGraphNodes}
                nodeOverrides={nodeOverrides}
                slopeOverrides={slopeOverrides}
                liftOverrides={liftOverrides}
                onSelectSlope={selectSlope}
                onSelectLift={selectLift}
                onSelectEdge={selectEdge}
                onSelectNode={selectNode}
              />
            )}

            {/* ── Edit zone: always immediately below the browser ── */}
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

            {selectedEdgeId !== null && (
              <EditEdgeStatusPanel
                selectedEdgeId={selectedEdgeId}
                selectedEdge={
                  selectedEdgeId
                    ? [
                        ...(loadedResort?.graph?.edges ?? []).map((e) => {
                          const ov = edgeOverrides[e.id];
                          return ov ? { ...e, ...ov } : e;
                        }),
                        ...addedGraphEdges,
                      ].find((e) => e.id === selectedEdgeId) ?? null
                    : null
                }
                onClearSelection={() => selectEdge(null)}
                onDelete={() => {
                  if (selectedEdgeId) deleteEdge(selectedEdgeId);
                }}
              />
            )}

            {selectedNodeId !== null && (
              <EditNodeStatusPanel
                selectedNodeId={selectedNodeId}
                selectedNode={
                  selectedNodeId
                    ? [
                        ...(loadedResort?.graph?.nodes ?? []).map((n) => {
                          const ov = nodeOverrides[n.id];
                          return ov ? { ...n, ...ov } : n;
                        }),
                        ...addedGraphNodes,
                      ].find((n) => n.id === selectedNodeId) ?? null
                    : null
                }
                hasOverride={
                  selectedNodeId !== null && !!nodeOverrides[selectedNodeId]
                }
                onPatchKind={(kind) => {
                  if (!selectedNodeId) return;
                  const isBaseline = (loadedResort?.graph?.nodes ?? []).some(
                    (n) => n.id === selectedNodeId,
                  );
                  if (isBaseline) {
                    setNodeOverrides((prev) => ({
                      ...prev,
                      [selectedNodeId]: { ...prev[selectedNodeId], kind },
                    }));
                  } else {
                    setAddedGraphNodes((prev) =>
                      prev.map((n) =>
                        n.id === selectedNodeId ? { ...n, kind } : n,
                      ),
                    );
                  }
                }}
                onPatchAlt={(alt_m) => {
                  if (!selectedNodeId) return;
                  const isBaseline = (loadedResort?.graph?.nodes ?? []).some(
                    (n) => n.id === selectedNodeId,
                  );
                  if (isBaseline) {
                    setNodeOverrides((prev) => ({
                      ...prev,
                      [selectedNodeId]: { ...prev[selectedNodeId], alt_m },
                    }));
                  } else {
                    setAddedGraphNodes((prev) =>
                      prev.map((n) =>
                        n.id === selectedNodeId ? { ...n, alt_m } : n,
                      ),
                    );
                  }
                }}
                onClearSelection={() => selectNode(null)}
                onDelete={() => {
                  if (selectedNodeId) deleteNode(selectedNodeId);
                }}
              />
            )}

            {/* ── Utility panels ── */}
            {loadedResort?.graph && (
              <LintPanel
                issues={lintIssues}
                onJump={(issue) => jumpToLintIssue(issue)}
              />
            )}

            {loadedResort?.graph && (
              <MergeCloseNodesPanel
                lastRewired={lastMergeRewired}
                deletedNodeCount={deletedGraphNodeIds.length}
                deletedEdgeCount={deletedGraphEdgeIds.length}
                onScan={() => {
                  const pair = findCloseNodePair();
                  if (!pair) {
                    setMergePrompt(null);
                    setLastMergeRewired(0);
                    return;
                  }
                  setMergePrompt(pair);
                }}
              />
            )}

            {mergePrompt && (
              <MergeNodePromptPanel
                keepId={mergePrompt.keepId}
                removeId={mergePrompt.removeId}
                distM={mergePrompt.distM}
                onConfirm={() => {
                  const { rewired } = mergeNodes(
                    mergePrompt.keepId,
                    mergePrompt.removeId,
                  );
                  setLastMergeRewired(rewired);
                  setMergePrompt(null);
                }}
                onCancel={() => setMergePrompt(null)}
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

            {picks.length > 0 && (
              <PickListPanel picks={picks} onClear={() => setPicks([])} />
            )}

            {patchBundle && <PatchPreviewPanel bundle={patchBundle} />}

            {patchBundle && (
              <PatchSaver bundle={patchBundle} onReset={discardDraft} />
            )}
          </div>
        </aside>
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
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
          <span className="font-semibold text-[var(--fg-dim)]">
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
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2 flex items-start justify-between gap-2">
        <div>
          <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
      <span className="font-semibold text-[var(--fg-dim)]">
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
      <span className="font-semibold text-[var(--fg-dim)]">
        {label}
      </span>
      <div className="grid grid-cols-3 gap-2">
        {I18N_LOCALES.map((locale) => (
          <label key={locale} className="grid gap-1">
            <span className="text-[9px] text-[var(--fg-dim)]">
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
      <span className="font-semibold text-[var(--fg-dim)]">
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
        <p className="text-[10px] font-semibold text-amber-300">
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
        <p className="text-[10px] font-semibold text-[#22d3ee]">
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

function EditEdgeStatusPanel({
  selectedEdgeId,
  selectedEdge,
  onClearSelection,
  onDelete,
}: {
  selectedEdgeId: string | null;
  selectedEdge: GraphEdge | null;
  onClearSelection: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  const kindKey =
    selectedEdge?.kind === "slope"
      ? "edgesPanelKindSlope"
      : selectedEdge?.kind === "lift"
        ? "edgesPanelKindLift"
        : selectedEdge?.kind === "traverse"
          ? "edgesPanelKindTraverse"
          : "edgesPanelKindOther";
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[#22d3ee]">
          {t("editEdgePanelTitle")}
        </p>
        {selectedEdge ? (
          <>
            <p className="mt-1 break-all text-[10px] text-[var(--fg-muted)]">
              {t("editEdgeSelectedLabel")}:{" "}
              <code>{selectedEdgeId}</code>
            </p>
            <p className="mt-0.5 break-all text-[10px] text-[var(--fg-muted)]">
              {t("editEdgeFromTo", {
                fromId: selectedEdge.from,
                toId: selectedEdge.to,
              })}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--fg-muted)]">
              {t("editEdgeVertexCount", {
                count: selectedEdge.geometry.length,
                kind: t(kindKey),
              })}
            </p>
            <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
              {t("editEdgeDragHint")}
            </p>
          </>
        ) : (
          <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
            {t("editEdgeNoSelection")}
          </p>
        )}
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onClearSelection}
          disabled={!selectedEdge}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-red-300 hover:text-red-200 disabled:opacity-40"
        >
          {t("editEdgeStopEditing")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!selectedEdge}
          className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-red-200 hover:bg-red-500/20 disabled:opacity-40"
        >
          {t("editEdgeDeleteButton")}
        </button>
      </div>
    </section>
  );
}

function EdgesListPanel({
  baselineEdges,
  addedEdges,
  overrides,
  selectedId,
  onSelect,
}: {
  baselineEdges: GraphEdge[];
  addedEdges: GraphEdge[];
  overrides: Record<string, EdgeOverride>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const editedCount = Object.keys(overrides).length;
  const total = baselineEdges.length + addedEdges.length;
  if (total === 0) {
    return (
      <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
        <header className="mb-1">
          <p className="text-[10px] font-semibold text-[var(--fg-muted)]">
            {t("edgesPanelTitle", { count: 0 })}
          </p>
        </header>
        <p className="text-[10px] text-[var(--fg-muted)]">
          {t("edgesPanelEmpty")}
        </p>
      </section>
    );
  }
  // Effective edge list (baseline-with-overrides ++ added) for the
  // panel. Baseline first to match the patch-bundle emission order.
  const effective: { e: GraphEdge; isAdded: boolean; isEdited: boolean }[] = [
    ...baselineEdges.map((e) => ({
      e: overrides[e.id] ? { ...e, ...overrides[e.id] } : e,
      isAdded: false,
      isEdited: !!overrides[e.id],
    })),
    ...addedEdges.map((e) => ({ e, isAdded: true, isEdited: false })),
  ];
  return (
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--fg-muted)]">
          {t("edgesPanelTitle", { count: total })}
          {editedCount > 0 ? (
            <span className="ml-2 text-[#22d3ee]">
              · {t("edgesPanelEditedChip", { count: editedCount })}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("edgesPanelHint")}
        </p>
      </header>
      <ul className="space-y-1 text-[11px]">
        {effective.map(({ e, isAdded, isEdited }) => {
          const isSel = e.id === selectedId;
          const kindKey =
            e.kind === "slope"
              ? "edgesPanelKindSlope"
              : e.kind === "lift"
                ? "edgesPanelKindLift"
                : e.kind === "traverse"
                  ? "edgesPanelKindTraverse"
                  : "edgesPanelKindOther";
          return (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => onSelect(e.id)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition ${
                  isSel
                    ? "border-[#22d3ee] bg-[#22d3ee]/10 text-[var(--fg)]"
                    : "border-[var(--border)] bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                }`}
                aria-pressed={isSel}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <code className="break-all text-[10px]">{e.id}</code>
                  <span className="flex flex-none items-center gap-1 text-[10px]">
                    {isAdded && (
                      <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-emerald-300">
                        new
                      </span>
                    )}
                    {isEdited && (
                      <span className="rounded bg-cyan-500/20 px-1 py-0.5 text-cyan-300">
                        ✎
                      </span>
                    )}
                    {isSel && (
                      <span className="rounded bg-cyan-500/20 px-1 py-0.5 text-cyan-300">
                        {t("edgesPanelSelected")}
                      </span>
                    )}
                  </span>
                </span>
                <span className="break-all text-[10px] text-[var(--fg-dim)]">
                  {e.from} → {e.to} · {e.geometry.length}v · {t(kindKey)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const NODE_KIND_OPTIONS: { value: GraphNodeKind | ""; labelKey: string }[] = [
  { value: "", labelKey: "editNodeKindUnset" },
  { value: "summit", labelKey: "editNodeKindSummit" },
  { value: "base", labelKey: "editNodeKindBase" },
  { value: "fork", labelKey: "editNodeKindFork" },
  { value: "merge", labelKey: "editNodeKindMerge" },
  { value: "lift_top", labelKey: "editNodeKindLiftTop" },
  { value: "lift_bottom", labelKey: "editNodeKindLiftBottom" },
  { value: "lift_station", labelKey: "editNodeKindLiftStation" },
  { value: "waypoint", labelKey: "editNodeKindWaypoint" },
];

function EditNodeStatusPanel({
  selectedNodeId,
  selectedNode,
  hasOverride,
  onPatchKind,
  onPatchAlt,
  onClearSelection,
  onDelete,
}: {
  selectedNodeId: string | null;
  selectedNode: GraphNode | null;
  hasOverride: boolean;
  onPatchKind: (kind: GraphNodeKind | undefined) => void;
  onPatchAlt: (alt_m: number) => void;
  onClearSelection: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[#22d3ee]">
          {t("editNodePanelTitle")}
        </p>
        {selectedNode ? (
          <>
            <p className="mt-1 break-all text-[10px] text-[var(--fg-muted)]">
              {t("editNodeSelectedLabel")}: <code>{selectedNodeId}</code>
              {hasOverride && (
                <span className="ml-2 rounded bg-cyan-500/20 px-1 py-0.5 text-[9px] text-cyan-300">
                  ✎
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[10px] text-[var(--fg-muted)]">
              {t("editNodeCoords", {
                lat: selectedNode.lat.toFixed(6),
                lng: selectedNode.lng.toFixed(6),
              })}
            </p>
            <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
              {t("editNodeDragHint")}
            </p>
          </>
        ) : (
          <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
            {t("editNodeNoSelection")}
          </p>
        )}
      </header>
      {selectedNode && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-[10px] font-semibold text-[var(--fg-muted)]">
              {t("editNodeKindLabel")}
            </span>
            <select
              value={selectedNode.kind ?? ""}
              onChange={(e) =>
                onPatchKind(
                  e.target.value ? (e.target.value as GraphNodeKind) : undefined,
                )
              }
              className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1 text-xs text-[var(--fg)]"
            >
              {NODE_KIND_OPTIONS.map((opt) => (
                <option key={opt.value || "unset"} value={opt.value}>
                  {t(opt.labelKey)}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-[10px] font-semibold text-[var(--fg-muted)]">
              {t("editNodeAltLabel")}
            </span>
            <input
              type="number"
              step={1}
              value={selectedNode.alt_m}
              onChange={(e) => {
                const v = Number.parseFloat(e.target.value);
                if (Number.isFinite(v)) onPatchAlt(v);
              }}
              className="mt-1 block w-full rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2 py-1 text-xs text-[var(--fg)]"
            />
          </label>
        </div>
      )}
      <div className="mt-2 flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onClearSelection}
          disabled={!selectedNode}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-red-300 hover:text-red-200 disabled:opacity-40"
        >
          {t("editNodeStopEditing")}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={!selectedNode}
          className="rounded-md border border-red-500/60 bg-red-500/10 px-3 py-1.5 text-red-200 hover:bg-red-500/20 disabled:opacity-40"
        >
          {t("editNodeDeleteButton")}
        </button>
      </div>
    </section>
  );
}

function NodesListPanel({
  baselineNodes,
  addedNodes,
  overrides,
  selectedId,
  onSelect,
}: {
  baselineNodes: GraphNode[];
  addedNodes: GraphNode[];
  overrides: Record<string, Partial<GraphNode>>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const editedCount = Object.keys(overrides).length;
  const total = baselineNodes.length + addedNodes.length;
  if (total === 0) {
    return (
      <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
        <header className="mb-1">
          <p className="text-[10px] font-semibold text-[var(--fg-muted)]">
            {t("nodesPanelTitle", { count: 0 })}
          </p>
        </header>
        <p className="text-[10px] text-[var(--fg-muted)]">
          {t("nodesPanelEmpty")}
        </p>
      </section>
    );
  }
  const effective: { n: GraphNode; isAdded: boolean; isEdited: boolean }[] = [
    ...baselineNodes.map((n) => ({
      n: overrides[n.id] ? { ...n, ...overrides[n.id] } : n,
      isAdded: false,
      isEdited: !!overrides[n.id],
    })),
    ...addedNodes.map((n) => ({ n, isAdded: true, isEdited: false })),
  ];
  return (
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--fg-muted)]">
          {t("nodesPanelTitle", { count: total })}
          {editedCount > 0 ? (
            <span className="ml-2 text-[#22d3ee]">
              · {t("nodesPanelEditedChip", { count: editedCount })}
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("nodesPanelHint")}
        </p>
      </header>
      <ul className="space-y-1 text-[11px]">
        {effective.map(({ n, isAdded, isEdited }) => {
          const isSel = n.id === selectedId;
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => onSelect(n.id)}
                className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition ${
                  isSel
                    ? "border-[#22d3ee] bg-[#22d3ee]/10 text-[var(--fg)]"
                    : "border-[var(--border)] bg-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                }`}
                aria-pressed={isSel}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <code className="break-all text-[10px]">{n.id}</code>
                  <span className="flex flex-none items-center gap-1 text-[10px]">
                    {isAdded && (
                      <span className="rounded bg-emerald-500/20 px-1 py-0.5 text-emerald-300">
                        new
                      </span>
                    )}
                    {isEdited && (
                      <span className="rounded bg-cyan-500/20 px-1 py-0.5 text-cyan-300">
                        ✎
                      </span>
                    )}
                    {isSel && (
                      <span className="rounded bg-cyan-500/20 px-1 py-0.5 text-cyan-300">
                        {t("nodesPanelSelected")}
                      </span>
                    )}
                  </span>
                </span>
                <span className="break-all text-[10px] text-[var(--fg-dim)]">
                  {n.kind ?? t("editNodeKindUnset")} · {n.alt_m.toFixed(0)}m
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function LintPanel({
  issues,
  onJump,
}: {
  issues: LintIssue[];
  onJump: (issue: LintIssue) => void;
}) {
  const t = useTranslations("slopeAuthor");
  // Tally by kind for the header row — gives an at-a-glance health
  // score even before the user scrolls.
  const counts = {
    "node-no-kind": 0,
    "node-orphan": 0,
    "slope-detached": 0,
    "lift-detached": 0,
  } as Record<LintIssue["kind"], number>;
  for (const i of issues) counts[i.kind] += 1;
  const total = issues.length;
  if (total === 0) {
    return (
      <section className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
        <header>
          <p className="text-[10px] font-semibold text-emerald-300">
            {t("lintPanelTitle", { count: 0 })}
          </p>
          <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
            {t("lintPanelEmpty")}
          </p>
        </header>
      </section>
    );
  }
  const labelFor = (i: LintIssue) => {
    if (i.kind === "node-no-kind") return t("lintNodeNoKind", { id: i.nodeId });
    if (i.kind === "node-orphan") return t("lintNodeOrphan", { id: i.nodeId });
    if (i.kind === "slope-detached")
      return t("lintSlopeDetached", { id: i.slopeId });
    return t("lintLiftDetached", { id: i.liftId });
  };
  const accentFor = (k: LintIssue["kind"]) => {
    if (k === "node-no-kind") return "text-amber-300";
    if (k === "node-orphan") return "text-yellow-300";
    if (k === "slope-detached") return "text-rose-300";
    return "text-rose-300";
  };
  return (
    <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-amber-300">
          {t("lintPanelTitle", { count: total })}
        </p>
        <p className="mt-1 flex flex-wrap gap-2 text-[10px] text-[var(--fg-muted)]">
          {counts["node-no-kind"] > 0 && (
            <span className="text-amber-300">
              {t("lintTallyNoKind", { count: counts["node-no-kind"] })}
            </span>
          )}
          {counts["node-orphan"] > 0 && (
            <span className="text-yellow-300">
              {t("lintTallyOrphan", { count: counts["node-orphan"] })}
            </span>
          )}
          {counts["slope-detached"] > 0 && (
            <span className="text-rose-300">
              {t("lintTallySlopeDetached", { count: counts["slope-detached"] })}
            </span>
          )}
          {counts["lift-detached"] > 0 && (
            <span className="text-rose-300">
              {t("lintTallyLiftDetached", { count: counts["lift-detached"] })}
            </span>
          )}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("lintPanelHint")}
        </p>
      </header>
      <ul className="max-h-48 space-y-1 overflow-y-auto text-[11px]">
        {issues.map((issue, i) => (
          <li key={`${issue.kind}-${i}`}>
            <button
              type="button"
              onClick={() => onJump(issue)}
              className="flex w-full items-center justify-between gap-2 rounded-md border border-[var(--border)] bg-transparent px-2 py-1.5 text-left text-[var(--fg-muted)] transition hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
            >
              <span className={`break-all text-[10px] ${accentFor(issue.kind)}`}>
                {labelFor(issue)}
              </span>
              <span aria-hidden className="text-[9px] text-[var(--fg-dim)]">
                →
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function WelcomeIntro({
  open,
  onDismiss,
}: {
  open: boolean;
  onDismiss: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  if (!open) return null;
  return (
    <section
      data-testid="welcome-intro"
      className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3"
    >
      <header className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold text-sky-300">
          {t("welcomeTitle")}
        </p>
        <button
          type="button"
          data-testid="welcome-dismiss"
          onClick={onDismiss}
          className="rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-[11px] font-semibold text-sky-100 transition hover:bg-sky-500/20"
        >
          {t("welcomeDismiss")}
        </button>
      </header>
      <ol className="space-y-2 text-[11px] text-[var(--fg-muted)]">
        <li className="flex items-start gap-2">
          <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-semibold leading-none text-sky-200">
            1
          </span>
          <span>{t("welcomeStep1")}</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-semibold leading-none text-sky-200">
            2
          </span>
          <span>{t("welcomeStep2")}</span>
        </li>
        <li className="flex items-start gap-2">
          <span className="mt-0.5 flex h-4 w-4 flex-none items-center justify-center rounded-full bg-sky-500/20 text-[10px] font-semibold leading-none text-sky-200">
            3
          </span>
          <span>{t("welcomeStep3")}</span>
        </li>
      </ol>
    </section>
  );
}

function ConflictBadge({ conflicts }: { conflicts: ConflictInfo[] }) {
  const t = useTranslations("slopeAuthor");
  if (conflicts.length === 0) return null;
  return (
    <section
      data-testid="conflict-badge"
      className="rounded-lg border border-orange-500/40 bg-orange-500/5 p-3"
    >
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-orange-300">
          {t("conflictsTitle", { count: conflicts.length })}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("conflictsHint")}
        </p>
      </header>
      <ul
        data-testid="conflict-list"
        className="space-y-1 text-[11px]"
      >
        {conflicts.map((c) => (
          <li
            key={c.number}
            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[10px]"
          >
            <a
              href={c.url}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-soft)] underline"
            >
              #{c.number}
            </a>{" "}
            <span className="text-[var(--fg)]">{c.title}</span>
            <span className="ml-1 text-[var(--fg-dim)]">— {c.user}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function RestoreBanner({
  draft,
  onRestore,
  onDiscard,
}: {
  draft: StoredDraft;
  onRestore: () => void;
  onDiscard: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  const locale = useLocale();
  const when = formatRelativeTime(draft.savedAt, locale);
  return (
    <section
      data-testid="restore-banner"
      className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3"
    >
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-amber-300">
          {t("restoreDraftTitle")}
        </p>
        <p className="mt-1 text-[11px] text-[var(--fg-muted)]">
          {t("restoreDraftBody", { when })}
        </p>
      </header>
      <div className="flex gap-2">
        <button
          type="button"
          data-testid="restore-draft-button"
          onClick={onRestore}
          className="flex-1 rounded-md border border-amber-500/40 bg-amber-500/15 px-2 py-1.5 text-[11px] font-semibold text-amber-100 transition hover:bg-amber-500/25"
        >
          {t("restoreDraftButton")}
        </button>
        <button
          type="button"
          data-testid="discard-draft-button"
          onClick={onDiscard}
          className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1.5 text-[11px] font-semibold text-[var(--fg-muted)] transition hover:text-[var(--fg)]"
        >
          {t("discardDraftButton")}
        </button>
      </div>
    </section>
  );
}

function UndoBar({
  depth,
  onUndo,
}: {
  depth: number;
  onUndo: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  if (depth === 0) return null;
  return (
    <section
      data-testid="undo-bar"
      className="flex items-center justify-between gap-2 rounded-lg border border-violet-500/40 bg-violet-500/5 px-3 py-2"
    >
      <span className="text-[10px] font-semibold text-violet-300">
        {t("undoBarLabel", { count: depth })}
      </span>
      <button
        type="button"
        data-testid="undo-button"
        onClick={onUndo}
        className="rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[11px] font-semibold text-violet-100 transition hover:bg-violet-500/20"
      >
        {t("undoBarButton")}
      </button>
    </section>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function PatchPreviewPanel({ bundle }: { bundle: PatchBundle }) {
  const t = useTranslations("slopeAuthor");
  const parts = (bundle.message ?? "")
    .replace(/^slope-author-2:\s*/, "")
    .split(" + ")
    .filter((p) => p.length > 0);
  const files = Object.entries(bundle.files);
  const totalBytes = files.reduce((sum, [, content]) => sum + content.length, 0);
  return (
    <section
      data-testid="patch-preview-panel"
      className="rounded-lg border border-sky-500/40 bg-sky-500/5 p-3"
    >
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-sky-300">
          {t("patchPreviewTitle", { count: parts.length })}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("patchPreviewHint")}
        </p>
      </header>
      <ul
        data-testid="patch-preview-parts"
        className="space-y-1 text-[11px]"
      >
        {parts.map((p) => (
          <li
            key={p}
            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-[10px] text-[var(--fg)]"
          >
            {p}
          </li>
        ))}
      </ul>
      <div className="mt-2 border-t border-[var(--border)] pt-2">
        <p className="text-[9px] text-[var(--fg-dim)]">
          {t("patchPreviewFilesLabel", { count: files.length })}
        </p>
        <ul
          data-testid="patch-preview-files"
          className="mt-1 space-y-0.5 text-[10px] text-[var(--fg-muted)]"
        >
          {files.map(([path, content]) => (
            <li
              key={path}
              className="flex items-center justify-between gap-2"
            >
              <span className="font-mono break-all">{path}</span>
              <span className="text-[var(--fg-dim)] tabular-nums">
                {formatBytes(content.length)}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-1 text-[9px] text-[var(--fg-dim)] tabular-nums">
          {t("patchPreviewTotalSize", { size: formatBytes(totalBytes) })}
        </p>
      </div>
    </section>
  );
}

function MergeCloseNodesPanel({
  lastRewired,
  deletedNodeCount,
  deletedEdgeCount,
  onScan,
}: {
  lastRewired: number | null;
  deletedNodeCount: number;
  deletedEdgeCount: number;
  onScan: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  const noneFound = lastRewired === 0 && deletedNodeCount === 0;
  return (
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--fg-muted)]">
          {t("mergeCloseNodesPanelTitle")}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("mergeCloseNodesHint")}
        </p>
      </header>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onScan}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          {t("mergeCloseNodesScanButton")}
        </button>
      </div>
      {(lastRewired !== null ||
        deletedNodeCount > 0 ||
        deletedEdgeCount > 0) && (
        <div className="mt-2 space-y-0.5 text-[10px] text-[var(--fg-muted)]">
          {noneFound && lastRewired === 0 && (
            <p>{t("mergeCloseNodesNoneFound")}</p>
          )}
          {lastRewired !== null && lastRewired > 0 && (
            <p className="text-emerald-300">
              · {t("mergeNodesRewired", { count: lastRewired })}
            </p>
          )}
          {deletedNodeCount > 0 && (
            <p>
              · {t("deletedGraphChipNodes", { count: deletedNodeCount })}
            </p>
          )}
          {deletedEdgeCount > 0 && (
            <p>
              · {t("deletedGraphChipEdges", { count: deletedEdgeCount })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function MergeNodePromptPanel({
  keepId,
  removeId,
  distM,
  onConfirm,
  onCancel,
}: {
  keepId: string;
  removeId: string;
  distM: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  const distLabel = distM < 0.1 ? "<0.1" : distM.toFixed(1);
  return (
    <section className="rounded-lg border border-amber-400/40 bg-amber-400/10 p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-amber-300">
          {t("mergeNodesPromptTitle")}
        </p>
        <p className="mt-1 text-[10px] text-[var(--fg-muted)]">
          {t("mergeNodesPromptBody", { distM: distLabel })}
        </p>
      </header>
      <div className="mb-2 grid grid-cols-1 gap-1 text-[10px] text-[var(--fg-muted)]">
        <p>
          <span className="font-semibold text-emerald-300">
            {t("mergeNodesKeepLabel")}:
          </span>{" "}
          <code className="break-all">{keepId}</code>
        </p>
        <p>
          <span className="font-semibold text-red-300">
            {t("mergeNodesRemoveLabel")}:
          </span>{" "}
          <code className="break-all">{removeId}</code>
        </p>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded-md bg-emerald-500/30 px-3 py-1.5 text-emerald-100 hover:bg-emerald-500/40"
        >
          {t("mergeNodesConfirm")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border border-[var(--border)] px-3 py-1.5 text-[var(--fg-muted)] hover:text-[var(--fg)]"
        >
          {t("mergeNodesCancel")}
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
        <p className="text-[10px] font-semibold text-[#22d3ee]">
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
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
        <p className="text-[10px] font-semibold text-[#22d3ee]">
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
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
          <span className="font-semibold text-[var(--fg-dim)]">
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
          <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] p-3">
      <header className="mb-2">
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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
        <p className="text-[10px] font-semibold text-[var(--accent-soft)]">
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

type EntityTab = "slopes" | "lifts" | "edges" | "nodes";

function EntityBrowserPanel({
  activeTab,
  onTabChange,
  search,
  onSearchChange,
  selectedId,
  slopes,
  lifts,
  baselineEdges,
  addedEdges,
  edgeOverrides,
  baselineNodes,
  addedNodes,
  nodeOverrides,
  slopeOverrides,
  liftOverrides,
  onSelectSlope,
  onSelectLift,
  onSelectEdge,
  onSelectNode,
}: {
  activeTab: EntityTab;
  onTabChange: (tab: EntityTab) => void;
  search: string;
  onSearchChange: (v: string) => void;
  selectedId: string | null;
  slopes: SlopeRecord[];
  lifts: LiftRecord[];
  baselineEdges: GraphEdge[];
  addedEdges: GraphEdge[];
  edgeOverrides: Record<string, EdgeOverride>;
  baselineNodes: GraphNode[];
  addedNodes: GraphNode[];
  nodeOverrides: Record<string, Partial<GraphNode>>;
  slopeOverrides: Record<string, SlopeOverride>;
  liftOverrides: Record<string, LiftOverride>;
  onSelectSlope: (id: string) => void;
  onSelectLift: (id: string) => void;
  onSelectEdge: (id: string) => void;
  onSelectNode: (id: string) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const listRef = useRef<HTMLUListElement>(null);
  const q = search.trim().toLowerCase();

  useEffect(() => {
    if (!listRef.current || !selectedId) return;
    const el = listRef.current.querySelector<HTMLElement>("[data-selected=true]");
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const tabs: { key: EntityTab; label: string; count: number }[] = [
    { key: "slopes", label: t("entityTabSlopes"), count: slopes.length },
    { key: "lifts", label: t("entityTabLifts"), count: lifts.length },
    {
      key: "edges",
      label: t("entityTabEdges"),
      count: baselineEdges.length + addedEdges.length,
    },
    {
      key: "nodes",
      label: t("entityTabNodes"),
      count: baselineNodes.length + addedNodes.length,
    },
  ];

  function matchesSearch(text: string) {
    return !q || text.toLowerCase().includes(q);
  }

  const selectedEdgeId =
    activeTab === "edges" ? selectedId : null;
  const selectedNodeId =
    activeTab === "nodes" ? selectedId : null;
  const selectedSlopeId =
    activeTab === "slopes" ? selectedId : null;
  const selectedLiftId =
    activeTab === "lifts" ? selectedId : null;

  return (
    <section className="rounded-2xl border border-white/5 bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] overflow-hidden">
      {/* Tab bar */}
      <div className="flex border-b border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => onTabChange(tab.key)}
            className={`flex-1 px-1 py-2 text-[10px] font-semibold transition ${
              activeTab === tab.key
                ? "border-b-2 border-[var(--accent)] text-[var(--fg)]"
                : "text-[var(--fg-dim)] hover:text-[var(--fg-muted)]"
            }`}
          >
            {tab.label}
            <span
              className={`ml-1 ${activeTab === tab.key ? "text-[var(--accent-soft)]" : "text-[var(--fg-dim)]"}`}
            >
              ({tab.count})
            </span>
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="border-b border-[var(--border)] px-2 py-1.5">
        <input
          type="search"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t("entitySearchPlaceholder")}
          className="w-full rounded-md bg-[var(--bg-elev)] px-2 py-1 text-[11px] text-[var(--fg)] placeholder:text-[var(--fg-dim)] outline-none"
        />
      </div>

      {/* List */}
      <ul
        ref={listRef}
        className="no-scrollbar max-h-56 overflow-y-auto space-y-0.5 p-1.5"
      >
        {activeTab === "slopes" &&
          slopes
            .filter((s) => matchesSearch(s.name ?? s.id))
            .map((s) => {
              const isSel = s.id === selectedSlopeId;
              const dirty = !!slopeOverrides[s.id];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    data-selected={isSel}
                    onClick={() => onSelectSlope(s.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                      isSel
                        ? "bg-[var(--accent)]/15 text-[var(--fg)]"
                        : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                    }`}
                  >
                    <span className="truncate font-medium">{s.name || s.id}</span>
                    <span className="flex flex-none items-center gap-1 text-[10px] text-[var(--fg-dim)]">
                      {dirty && (
                        <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold text-amber-300">
                          &#x270E;
                        </span>
                      )}
                      {(s.coordinates?.length ?? 0)}pt
                    </span>
                  </button>
                </li>
              );
            })}

        {activeTab === "lifts" &&
          lifts
            .filter((l) => matchesSearch(l.name ?? l.id))
            .map((l) => {
              const isSel = l.id === selectedLiftId;
              const dirty = !!liftOverrides[l.id];
              return (
                <li key={l.id}>
                  <button
                    type="button"
                    data-selected={isSel}
                    onClick={() => onSelectLift(l.id)}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition ${
                      isSel
                        ? "bg-[var(--accent)]/15 text-[var(--fg)]"
                        : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                    }`}
                  >
                    <span className="truncate font-medium">{l.name || l.id}</span>
                    <span className="flex flex-none items-center gap-1 text-[10px] text-[var(--fg-dim)]">
                      {dirty && (
                        <span className="rounded bg-amber-500/20 px-1 py-0.5 text-[9px] font-semibold text-amber-300">
                          &#x270E;
                        </span>
                      )}
                      {l.type ?? "—"}
                    </span>
                  </button>
                </li>
              );
            })}

        {activeTab === "edges" &&
          [
            ...baselineEdges.map((e) => ({
              e: edgeOverrides[e.id] ? { ...e, ...edgeOverrides[e.id] } : e,
              isAdded: false,
              isEdited: !!edgeOverrides[e.id],
            })),
            ...addedEdges.map((e) => ({ e, isAdded: true, isEdited: false })),
          ]
            .filter(({ e }) =>
              matchesSearch(`${e.id} ${e.from} ${e.to} ${e.kind}`),
            )
            .map(({ e, isAdded, isEdited }) => {
              const isSel = e.id === selectedEdgeId;
              return (
                <li key={e.id}>
                  <button
                    type="button"
                    data-selected={isSel}
                    onClick={() => onSelectEdge(e.id)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition ${
                      isSel
                        ? "border-[#22d3ee] bg-[#22d3ee]/10 text-[var(--fg)]"
                        : "border-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                    }`}
                    aria-pressed={isSel}
                  >
                    <span className="flex w-full items-center justify-between gap-1">
                      <code className="text-[10px]">{e.id}</code>
                      <span className="flex items-center gap-1 text-[9px]">
                        {isAdded && (
                          <span className="rounded bg-emerald-500/20 px-1 text-emerald-300">new</span>
                        )}
                        {isEdited && (
                          <span className="rounded bg-cyan-500/20 px-1 text-cyan-300">&#x270E;</span>
                        )}
                      </span>
                    </span>
                    <span className="text-[10px] text-[var(--fg-dim)]">
                      {e.from} → {e.to} · {e.geometry.length}v · {e.kind}
                    </span>
                  </button>
                </li>
              );
            })}

        {activeTab === "nodes" &&
          [
            ...baselineNodes.map((n) => ({
              n: nodeOverrides[n.id] ? { ...n, ...nodeOverrides[n.id] } : n,
              isAdded: false,
              isEdited: !!nodeOverrides[n.id],
            })),
            ...addedNodes.map((n) => ({ n, isAdded: true, isEdited: false })),
          ]
            .filter(({ n }) => matchesSearch(`${n.id} ${n.kind ?? ""}`))
            .map(({ n, isAdded, isEdited }) => {
              const isSel = n.id === selectedNodeId;
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    data-selected={isSel}
                    onClick={() => onSelectNode(n.id)}
                    className={`flex w-full flex-col items-start gap-0.5 rounded-md border px-2 py-1.5 text-left transition ${
                      isSel
                        ? "border-[#22d3ee] bg-[#22d3ee]/10 text-[var(--fg)]"
                        : "border-transparent text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
                    }`}
                    aria-pressed={isSel}
                  >
                    <span className="flex w-full items-center justify-between gap-1">
                      <code className="text-[10px]">{n.id}</code>
                      <span className="flex items-center gap-1 text-[9px]">
                        {isAdded && (
                          <span className="rounded bg-emerald-500/20 px-1 text-emerald-300">new</span>
                        )}
                        {isEdited && (
                          <span className="rounded bg-cyan-500/20 px-1 text-cyan-300">&#x270E;</span>
                        )}
                      </span>
                    </span>
                    <span className="text-[10px] text-[var(--fg-dim)]">
                      {n.kind ?? "waypoint"} · {n.alt_m}m
                    </span>
                  </button>
                </li>
              );
            })}
      </ul>
    </section>
  );
}
