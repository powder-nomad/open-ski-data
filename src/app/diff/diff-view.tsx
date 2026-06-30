"use client";

/**
 * Diff viewer main component — mirrors the shape of editor.tsx.
 *
 * Full-canvas Google Maps with glass card overlays. Shows the
 * changeset for a PR or base/head SHA pair on the live map.
 *
 * Public route — no OAuth gate. Any read of the public repo is
 * unauthenticated (raw.githubusercontent.com + GitHub API public
 * endpoints). Rate limit: 60 req/hr unauth, well within typical PR
 * review usage.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { setOptions, importLibrary } from "@googlemaps/js-api-loader";
import { webRuntimeConfig } from "@/lib/runtime-config";
import { usePrDiff } from "./use-pr-diff";
import { DiffSummary } from "./diff-summary";
import { DiffLanding } from "./diff-landing";
import type { GraphNode, GraphEdge } from "@/lib/resort-loader";

// Module-level guard — shared across editor.tsx if both are mounted
// (they won't be simultaneously, but guard is idempotent).
let mapsConfigured = false;

const KOREA_CENTER = { lat: 37.5, lng: 128.0 };
const DEFAULT_ZOOM = 8;

// Overlay colors
const COLOR_REMOVED = "#ef4444"; // red-500
const COLOR_ADDED = "#22c55e"; // green-500
const COLOR_MODIFIED = "#eab308"; // yellow-500
const COLOR_CONTEXT = "#94a3b8"; // slate-400

const UPSTREAM = "https://github.com/powder-nomad/open-ski-data";

function sha7(sha: string) {
  return sha.slice(0, 7);
}

type PolylineRef = {
  line: google.maps.Polyline;
  kind: "removed" | "added" | "modified-old" | "modified-new" | "context";
};

export function DiffView() {
  const searchParams = useSearchParams();
  const diff = usePrDiff(searchParams);

  const mapRef = useRef<HTMLDivElement | null>(null);
  const googleMap = useRef<google.maps.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);

  const overlayRefs = useRef<PolylineRef[]>([]);
  const nodeMarkersRef = useRef<google.maps.Marker[]>([]);

  // ── Map bootstrap ─────────────────────────────────────────────────
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
        if (cancelled || !mapRef.current) return;
        const map = new Map(mapRef.current, {
          center: KOREA_CENTER,
          zoom: DEFAULT_ZOOM,
          mapTypeId: "terrain",
          clickableIcons: false,
          gestureHandling: "greedy",
          zoomControl: false,
          mapTypeControl: false,
          streetViewControl: false,
          fullscreenControl: false,
          rotateControl: false,
          scaleControl: false,
        });
        googleMap.current = map;
        setMapReady(true);
      } catch (err) {
        setMapError(err instanceof Error ? err.message : String(err));
      }
    }

    void init();
    return () => { cancelled = true; };
  }, []);

  // ── Clear overlays ────────────────────────────────────────────────
  const clearOverlays = useCallback(() => {
    for (const { line } of overlayRefs.current) line.setMap(null);
    overlayRefs.current = [];
    for (const m of nodeMarkersRef.current) m.setMap(null);
    nodeMarkersRef.current = [];
  }, []);

  // ── Draw overlays when diff + map are ready ───────────────────────
  useEffect(() => {
    if (!mapReady || !googleMap.current || diff.status !== "done") return;
    const map = googleMap.current;

    clearOverlays();

    const resort = diff.resorts.find((r) => r.slug === diff.selectedResort);
    if (!resort) return;

    const { graphDiff } = resort;
    const bounds = new google.maps.LatLngBounds();
    let hasBounds = false;

    function addPolyline(
      coords: { lat: number; lng: number }[],
      kind: PolylineRef["kind"],
    ) {
      const isRemoved = kind === "removed" || kind === "modified-old";
      const isAdded = kind === "added" || kind === "modified-new";
      const isContext = kind === "context";

      const strokeColor = isContext
        ? COLOR_CONTEXT
        : isRemoved
        ? COLOR_REMOVED
        : isAdded
        ? COLOR_ADDED
        : COLOR_MODIFIED;

      const opacity = isContext ? 0.3 : isRemoved ? 0.6 : 0.8;
      const isDashed = kind === "removed" || kind === "modified-old";
      const strokeDashArray = isDashed ? "8 4" : undefined;

      const line = new google.maps.Polyline({
        path: coords,
        map,
        strokeColor,
        strokeOpacity: strokeDashArray ? 0 : opacity,
        strokeWeight: isContext ? 1.5 : 2.5,
        zIndex: isContext ? 1 : isRemoved ? 2 : 3,
        icons: strokeDashArray
          ? [
              {
                icon: {
                  path: "M 0,-1 0,1",
                  strokeOpacity: opacity,
                  strokeColor,
                  scale: 2.5,
                },
                offset: "0",
                repeat: "10px",
              },
            ]
          : undefined,
      });

      overlayRefs.current.push({ line, kind });
      for (const c of coords) bounds.extend(c);
      hasBounds = true;
    }

    function addNodeMarker(node: GraphNode, kind: "removed" | "added" | "modified") {
      const color = kind === "removed" ? COLOR_REMOVED : kind === "added" ? COLOR_ADDED : COLOR_MODIFIED;
      const marker = new google.maps.Marker({
        position: { lat: node.lat, lng: node.lng },
        map,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: kind === "removed" ? 6 : 7,
          fillColor: color,
          fillOpacity: kind === "removed" ? 0.6 : 0.85,
          strokeColor: color,
          strokeWeight: 2,
        },
        zIndex: kind === "added" ? 5 : 4,
      });
      nodeMarkersRef.current.push(marker);
      bounds.extend({ lat: node.lat, lng: node.lng });
      hasBounds = true;
    }

    // Draw nodes
    for (const nd of graphDiff.nodes) {
      if (nd.kind === "removed" && nd.before) addNodeMarker(nd.before, "removed");
      else if (nd.kind === "added" && nd.after) addNodeMarker(nd.after, "added");
      else if (nd.kind === "modified" && nd.after) addNodeMarker(nd.after, "modified");
    }

    // Draw edges
    for (const ed of graphDiff.edges) {
      const edgeToPath = (e: GraphEdge) =>
        e.geometry.map((p) => ({ lat: p.lat, lng: p.lng }));

      if (ed.kind === "removed" && ed.before) {
        addPolyline(edgeToPath(ed.before), "removed");
      } else if (ed.kind === "added" && ed.after) {
        addPolyline(edgeToPath(ed.after), "added");
      } else if (ed.kind === "modified") {
        if (ed.before) addPolyline(edgeToPath(ed.before), "modified-old");
        if (ed.after) addPolyline(edgeToPath(ed.after), "modified-new");
      }
    }

    if (hasBounds && !bounds.isEmpty()) {
      map.fitBounds(bounds, 80);
    }
  }, [mapReady, diff.status, diff.selectedResort, diff.resorts, clearOverlays]);

  // ── Focus helpers (called by DiffSummary row clicks) ─────────────
  const focusNodes = useCallback(
    (ids: string[]) => {
      const map = googleMap.current;
      if (!map) return;
      const resort = diff.resorts.find((r) => r.slug === diff.selectedResort);
      if (!resort) return;
      const targeted = resort.graphDiff.nodes.filter((n) => ids.includes(n.id));
      if (targeted.length === 0) return;
      const b = new google.maps.LatLngBounds();
      for (const nd of targeted) {
        const node = nd.after ?? nd.before;
        if (node) b.extend({ lat: node.lat, lng: node.lng });
      }
      if (!b.isEmpty()) map.fitBounds(b, 120);
    },
    [diff.resorts, diff.selectedResort],
  );

  const focusEdges = useCallback(
    (ids: string[]) => {
      const map = googleMap.current;
      if (!map) return;
      const resort = diff.resorts.find((r) => r.slug === diff.selectedResort);
      if (!resort) return;
      const targeted = resort.graphDiff.edges.filter((e) => ids.includes(e.id));
      if (targeted.length === 0) return;
      const b = new google.maps.LatLngBounds();
      for (const ed of targeted) {
        const edge = ed.after ?? ed.before;
        if (edge) for (const p of edge.geometry) b.extend({ lat: p.lat, lng: p.lng });
      }
      if (!b.isEmpty()) map.fitBounds(b, 80);
    },
    [diff.resorts, diff.selectedResort],
  );

  const focusSlopes = useCallback(
    (ids: string[]) => {
      const map = googleMap.current;
      if (!map) return;
      const resort = diff.resorts.find((r) => r.slug === diff.selectedResort);
      if (!resort) return;
      const targeted = resort.sidecarDiff.slopes.filter((s) => ids.includes(s.id));
      if (targeted.length === 0) return;
      const b = new google.maps.LatLngBounds();
      for (const sd of targeted) {
        const slope = sd.after ?? sd.before;
        if (slope) for (const c of slope.coordinates) b.extend({ lat: c.lat, lng: c.lon });
      }
      if (!b.isEmpty()) map.fitBounds(b, 80);
    },
    [diff.resorts, diff.selectedResort],
  );

  const focusLifts = useCallback(
    (ids: string[]) => {
      const map = googleMap.current;
      if (!map) return;
      const resort = diff.resorts.find((r) => r.slug === diff.selectedResort);
      if (!resort) return;
      const targeted = resort.sidecarDiff.lifts.filter((l) => ids.includes(l.id));
      if (targeted.length === 0) return;
      const b = new google.maps.LatLngBounds();
      for (const ld of targeted) {
        const lift = ld.after ?? ld.before;
        if (lift) for (const c of lift.coordinates) b.extend({ lat: c.lat, lng: c.lon });
      }
      if (!b.isEmpty()) map.fitBounds(b, 80);
    },
    [diff.resorts, diff.selectedResort],
  );

  // ── Idle/empty state ──────────────────────────────────────────────
  const isIdle = diff.status === "idle";
  const isLoading = diff.status === "resolving" || diff.status === "fetching" || diff.status === "diffing";

  const currentResort = diff.resorts.find((r) => r.slug === diff.selectedResort) ?? null;

  const editorLink = currentResort
    ? `/?resort=${currentResort.slug}`
    : "/";

  const prLinkHref = diff.prNumber
    ? `${UPSTREAM}/pull/${diff.prNumber}`
    : diff.head
    ? `${UPSTREAM}/compare/${diff.base}...${diff.head}`
    : null;

  return (
    <div className="relative w-screen h-screen overflow-hidden">
      {/* Full-canvas map */}
      <div ref={mapRef} className="absolute inset-0" />

      {mapError && (
        <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-surface)]">
          <p className="text-sm text-[#f87171]">Map error: {mapError}</p>
        </div>
      )}

      {/* Top-left card — PR info */}
      <div className={`absolute left-3 top-3 z-10 rounded-2xl bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] border border-white/5 p-3 w-[calc(100vw-5rem)] ${isIdle ? "md:w-80" : "md:w-72"}`}>
        {isIdle ? (
          <div className="space-y-3">
            <p className="text-sm font-semibold text-[var(--fg)]">PR diff viewer</p>
            <DiffLanding />
          </div>
        ) : isLoading ? (
          <div className="space-y-1">
            <p className="text-sm font-semibold text-[var(--fg)]">Loading diff…</p>
            <p className="text-xs text-[var(--fg-muted)] capitalize">{diff.status}</p>
          </div>
        ) : diff.status === "error" ? (
          <div className="space-y-1">
            <p className="text-sm font-semibold text-[#f87171]">Error</p>
            <p className="text-xs text-[var(--fg-muted)]">{diff.error}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {diff.prTitle && (
              <p className="text-sm font-semibold text-[var(--fg)] leading-snug line-clamp-2">
                {prLinkHref ? (
                  <a
                    href={prLinkHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-[var(--accent)] transition-colors"
                  >
                    {diff.prNumber ? `#${diff.prNumber} ` : ""}
                    {diff.prTitle}
                  </a>
                ) : (
                  <>{diff.prNumber ? `#${diff.prNumber} ` : ""}{diff.prTitle}</>
                )}
              </p>
            )}
            {diff.base && diff.head && (
              <p className="text-[10px] font-mono text-[var(--fg-dim)]">
                {sha7(diff.base)} → {sha7(diff.head)}
              </p>
            )}
            {currentResort && (
              <a
                href={editorLink}
                className="block text-xs text-[var(--accent)] hover:text-[var(--accent-soft)] transition-colors"
              >
                Open in editor →
              </a>
            )}
          </div>
        )}
      </div>

      {/* Right panel — diff summary */}
      {!isIdle && (
        <div
          className="absolute right-3 top-3 z-10 rounded-2xl bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] border border-white/5 p-3"
          style={{ width: "22rem", maxHeight: "calc(100vh - 1.5rem)", overflowY: "auto" }}
        >
          {isLoading ? (
            <div className="text-xs text-[var(--fg-muted)]">
              {diff.status === "resolving" && "Resolving SHAs…"}
              {diff.status === "fetching" && "Fetching changed files…"}
              {diff.status === "diffing" && "Computing diff…"}
            </div>
          ) : diff.status === "error" ? (
            <div className="text-xs text-[#f87171]">{diff.error}</div>
          ) : diff.resorts.length === 0 ? (
            <div className="text-xs text-[var(--fg-muted)]">
              No registry files changed in this diff.
            </div>
          ) : (
            <DiffSummary
              resort={currentResort}
              allResorts={diff.resorts}
              selectedResort={diff.selectedResort}
              onSelectResort={diff.setSelectedResort}
              onFocusNodes={focusNodes}
              onFocusEdges={focusEdges}
              onFocusSlopes={focusSlopes}
              onFocusLifts={focusLifts}
            />
          )}
        </div>
      )}

      {/* Color legend — bottom-left */}
      {diff.status === "done" && diff.resorts.length > 0 && (
        <div className="absolute left-3 bottom-3 z-10 rounded-2xl bg-[var(--bg-glass)] backdrop-blur-md shadow-[var(--shadow-glass)] border border-white/5 px-3 py-2 flex gap-4">
          {[
            { color: "#ef4444", label: "removed" },
            { color: "#22c55e", label: "added" },
            { color: "#eab308", label: "modified" },
            { color: "#94a3b8", label: "context", opacity: 0.5 },
          ].map(({ color, label, opacity }) => (
            <div key={label} className="flex items-center gap-1.5 text-[10px] text-[var(--fg-muted)]">
              <span
                className="inline-block w-6 h-0.5 rounded"
                style={{ background: color, opacity: opacity ?? 1 }}
              />
              {label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
