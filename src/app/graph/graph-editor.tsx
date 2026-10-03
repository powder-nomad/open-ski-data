"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { importLibrary, setOptions } from "@googlemaps/js-api-loader";
import { PatchSaver, type PatchBundle } from "@/lib/ci-status";
import {
  addEdge, addNode, continuation, dropNode, editPair, importLine, joinEdges, mergeNode, moveNode, orientByElevation, piecesOf,
  positionKey, positions, primaryOf, redundantLinks, removeEdges, removeNode, reshapeEdge, splitEdge, twinOf, type Graph,
} from "@/lib/graph-ops";
import { flipped, nearPairs, reverseLink, reviewItems, strandedEdges, userEdit } from "@/lib/graph-review";
import { fetchManifest, loadResort, stitchEdges, type ResortRef, type GraphEdge, type GraphNode, type LiftRecord, type LoadedResort, type SlopeRecord } from "@/lib/resort-loader";
import { webRuntimeConfig } from "@/lib/runtime-config";
import { useSession } from "@/lib/use-session";

/**
 * The graph editor: one screen for a resort's slopes and lifts as a
 * connected graph.
 *
 * There is one set of lines on the map, the graph's. A slope or lift is a
 * name that pieces belong to, listed once on the right; picking it there
 * and clicking one of its pieces on the map select the same thing. There
 * are no modes: you select something and act on it, or you press "draw"
 * on a slope, a lift or "link" and draw.
 *
 * All edits go through pure functions on the whole graph (lib/graph-ops),
 * so undo is just the previous graph.
 */

type Record_ = { kind: "slope" | "lift"; id: string; name: string; difficulty?: string | null; coords: { lat: number; lng: number }[] };
type Selection = { type: "edge" | "node" | "record"; id: string } | null;
type Drawing = { kind: GraphEdge["kind"]; recordId: string | null; anchor: string | null; bends: { lat: number; lng: number }[] } | null;

const KOREA = { lat: 37.5, lng: 128.0 };
const UNDO_DEPTH = 40;
let mapsConfigured = false;

const SELECTED = "#06b6d4";
/** Every slope is one colour: the grade is in the sidebar, not on the map. */
const SLOPE = "#2563eb";
const LIFT = "#e11d48";
const LINK = { observed: "#16a34a", suggested: "#d97706", "user-edit": "#2563eb", osm: "#64748b" } as const;

function recordKey(kind: "slope" | "lift", id: string) {
  return `${kind}:${id}`;
}

export function GraphEditor() {
  const t = useTranslations("graphEditor");
  const locale = useLocale();
  const { user } = useSession();
  const login = user?.login;

  const [resort, setResort] = useState<LoadedResort | null>(null);
  const [graph, setGraph] = useState<Graph>({ nodes: [], edges: [] });
  const [history, setHistory] = useState<Graph[]>([]);
  const [selection, setSelection] = useState<Selection>(null);
  const [drawing, setDrawing] = useState<Drawing>(null);
  const [cutArmed, setCutArmed] = useState(false);
  const [joinOnDrop, setJoinOnDrop] = useState(false);
  const [search, setSearch] = useState("");
  const [satellite, setSatellite] = useState(false);
  const [measuring, setMeasuring] = useState<"idle" | "busy" | "failed" | { flipped: number }>("idle");
  // Slopes and lifts added here, and changes to the names or grades of existing ones.
  const [addedSlopes, setAddedSlopes] = useState<SlopeRecord[]>([]);
  const [addedLifts, setAddedLifts] = useState<LiftRecord[]>([]);
  const [recordEdits, setRecordEdits] = useState<Record<string, { name?: string; difficulty?: string; type?: string }>>({});
  const [adding, setAdding] = useState<"slope" | "lift" | null>(null);
  /** Slopes and lifts taken out of the catalog here ("slope:id"). */
  const [removedRecords, setRemovedRecords] = useState<string[]>([]);
  const [collapsed, setCollapsed] = useState(false);

  const mapEl = useRef<HTMLDivElement>(null);
  const map = useRef<google.maps.Map | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const overlays = useRef<(google.maps.Polyline | google.maps.Marker)[]>([]);

  // ── data ────────────────────────────────────────────────────────────

  useEffect(() => {
    setGraph(resort?.graph ? { nodes: resort.graph.nodes, edges: resort.graph.edges } : { nodes: [], edges: [] });
    setHistory([]);
    setSelection(null);
    setDrawing(null);
    setCutArmed(false);
    setMeasuring("idle");
    setAddedSlopes([]);
    setAddedLifts([]);
    setRecordEdits({});
    setAdding(null);
    setRemovedRecords([]);
  }, [resort]);

  /** Every edit goes through here, so every edit can be undone. */
  const commit = useCallback((next: Graph) => {
    setGraph((current) => {
      if (next === current) return current;
      setHistory((h) => [...h.slice(-(UNDO_DEPTH - 1)), current]);
      return next;
    });
  }, []);
  const undo = useCallback(() => {
    setHistory((h) => {
      if (h.length === 0) return h;
      setGraph(h[h.length - 1]);
      return h.slice(0, -1);
    });
  }, []);

  const records: Record_[] = useMemo(() => {
    if (!resort) return [];
    const name = (kind: string, r: SlopeRecord | LiftRecord) => recordEdits[`${kind}:${r.id}`]?.name || r.name_i18n?.[locale] || r.name_i18n?.en || r.name || r.id;
    const gone = new Set(removedRecords);
    return [
      ...[...resort.slopes, ...addedSlopes].filter((s) => !gone.has(`slope:${s.id}`)).map((s) => ({ kind: "slope" as const, id: s.id, name: name("slope", s), difficulty: recordEdits[`slope:${s.id}`]?.difficulty ?? s.difficulty, coords: (s.coordinates ?? []).map((c) => ({ lat: c.lat, lng: c.lon })) })),
      ...[...resort.lifts, ...addedLifts].filter((l) => !gone.has(`lift:${l.id}`)).map((l) => ({ kind: "lift" as const, id: l.id, name: name("lift", l), coords: (l.coordinates ?? []).map((c) => ({ lat: c.lat, lng: c.lon })) })),
    ];
  }, [resort, locale, addedSlopes, addedLifts, recordEdits, removedRecords]);
  const recordByKey = useMemo(() => new Map(records.map((r) => [recordKey(r.kind, r.id), r])), [records]);
  const nodeById = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph.nodes]);
  const pieceCount = useMemo(() => {
    const count = new Map<string, number>();
    for (const e of graph.edges) {
      const id = e.kind === "slope" ? e.slope_id : e.kind === "lift" ? e.lift_id : null;
      if (id && e.kind !== "traverse") count.set(recordKey(e.kind, id), (count.get(recordKey(e.kind, id)) ?? 0) + 1);
    }
    return count;
  }, [graph.edges]);

  const recordOf = (e: GraphEdge): Record_ | undefined => {
    const id = e.kind === "slope" ? e.slope_id : e.kind === "lift" ? e.lift_id : null;
    return id && e.kind !== "traverse" ? recordByKey.get(recordKey(e.kind, id)) : undefined;
  };
  const edgeName = (e: GraphEdge): string => {
    if (e.kind === "traverse") return t("link");
    return recordOf(e)?.name ?? t(e.kind === "lift" ? "unnamedLift" : "unnamedSlope");
  };

  const selectedEdge = selection?.type === "edge" ? graph.edges.find((e) => e.id === selection.id) ?? null : null;
  const selectedNode = selection?.type === "node" ? nodeById.get(selection.id) ?? null : null;
  const selectedRecord = selection?.type === "record" ? recordByKey.get(selection.id) ?? null : selectedEdge ? recordOf(selectedEdge) ?? null : null;
  const highlighted = selectedRecord ? recordKey(selectedRecord.kind, selectedRecord.id) : null;

  // One entry per line: the second direction of a two-way line is not a second thing to review.
  const review = useMemo(
    () => reviewItems(graph.edges, nodeById).filter((item) => {
      const e = graph.edges.find((x) => x.id === item.edgeId);
      return e != null && primaryOf(graph, e).id === e.id;
    }),
    [graph, nodeById],
  );
  const selectedTwin = selectedEdge ? twinOf(graph, selectedEdge) : undefined;
  const near = useMemo(() => nearPairs(graph.nodes, graph.edges), [graph]);
  const redundant = useMemo(() => redundantLinks(graph), [graph]);
  const stranded = useMemo(() => strandedEdges(graph.nodes, graph.edges), [graph]);

  /** Take a slope or lift out of the catalog, with every piece of it. */
  const removeRecord = (r: Record_) => {
    commit(removeEdges(graph, piecesOf(graph, r.kind, r.id).map((e) => e.id)));
    setRemovedRecords((list) => [...list, recordKey(r.kind, r.id)]);
    setSelection(null);
  };

  /** A new slope or lift: a name in the list, ready to have its line drawn. */
  const addRecord = (kind: "slope" | "lift", name: string, grade: string) => {
    const taken = new Set(records.filter((r) => r.kind === kind).map((r) => r.id));
    const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    let id = slug || `${kind}-${Date.now().toString(36)}`;
    for (let i = 2; taken.has(id); i++) id = `${slug || kind}-${i}`;
    const names = { [locale]: name };
    if (kind === "slope") setAddedSlopes((list) => [...list, { id, name, name_i18n: names, type: "run", difficulty: grade || null, coordinates: [] }]);
    else setAddedLifts((list) => [...list, { id, name, name_i18n: names, type: grade || "chair_lift", coordinates: [] }]);
    setAdding(null);
    setSelection({ type: "record", id: recordKey(kind, id) });
    startDrawing(kind, id);
  };

  // ── actions ─────────────────────────────────────────────────────────

  const fit = (points: { lat: number; lng: number }[]) => {
    if (!map.current || points.length === 0) return;
    const bounds = new google.maps.LatLngBounds();
    points.forEach((p) => bounds.extend(p));
    map.current.fitBounds(bounds, { top: 60, bottom: 60, left: 60, right: collapsed ? 60 : 440 });
  };

  const selectRecord = (r: Record_) => {
    setSelection({ type: "record", id: recordKey(r.kind, r.id) });
    const pieces = piecesOf(graph, r.kind, r.id);
    fit(pieces.length ? pieces.flatMap((e) => e.geometry) : r.coords);
  };
  const selectEdge = (id: string, pan = false) => {
    // A two-way line is one thing on the map: whichever direction was asked for, its drawn one is selected.
    const asked = graph.edges.find((x) => x.id === id);
    const e = asked ? primaryOf(graph, asked) : undefined;
    setSelection({ type: "edge", id: e?.id ?? id });
    if (pan && e) fit(e.geometry);
  };

  const startDrawing = (kind: GraphEdge["kind"], recordId: string | null) => {
    setCutArmed(false);
    setDrawing({ kind, recordId, anchor: null, bends: [] });
  };

  /** A click while drawing that lands on a node: the start, or the end. */
  const drawToNode = (nodeId: string) => {
    if (!drawing) return;
    if (!drawing.anchor) return setDrawing({ ...drawing, anchor: nodeId });
    if (drawing.anchor === nodeId) return;
    const to = nodeById.get(nodeId);
    const bends = to ? drawing.bends.filter((p) => Math.hypot(p.lat - to.lat, p.lng - to.lng) > 3e-5) : drawing.bends;
    const drawn = addEdge(graph, drawing.anchor, nodeId, bends, { kind: drawing.kind, recordId: drawing.recordId }, login);
    if (!drawn) return;
    commit(drawn.graph);
    // A link or a lift is one piece; a slope usually carries on, so keep drawing from where it ended.
    setDrawing(drawing.kind === "slope" ? { ...drawing, anchor: nodeId, bends: [] } : null);
    setSelection({ type: "edge", id: drawn.edgeId });
  };
  /** A click while drawing that lands on a line: cut it there, and use the cut. */
  const drawToLine = (edgeId: string, lat: number, lng: number) => {
    let cutNode: string | null = null;
    const cutGraph = editPair(graph, edgeId, (g) => {
      const made = splitEdge(g, edgeId, lat, lng, login);
      cutNode = made?.nodeId ?? null;
      return made?.graph ?? g;
    });
    if (!cutNode) return;
    const cut = { graph: cutGraph, nodeId: cutNode as string };
    if (!drawing?.anchor) {
      commit(cut.graph);
      if (drawing) setDrawing({ ...drawing, anchor: cut.nodeId });
      return;
    }
    const drawn = addEdge(cut.graph, drawing.anchor, cut.nodeId, drawing.bends, { kind: drawing.kind, recordId: drawing.recordId }, login);
    commit(drawn?.graph ?? cut.graph);
    setDrawing(drawing.kind === "slope" ? { ...drawing, anchor: cut.nodeId, bends: [] } : null);
  };
  /** A double-click on open map while drawing: a new node there, as the start or the end. */
  const drawToNewNode = (lat: number, lng: number) => {
    if (!drawing) return;
    const from = drawing.anchor ? nodeById.get(drawing.anchor) : undefined;
    const made = addNode(graph, lat, lng, from?.alt_m ?? 0);
    if (!from) {
      commit(made.graph);
      setDrawing({ ...drawing, anchor: made.nodeId });
      return;
    }
    const bends = drawing.bends.filter((p) => Math.hypot(p.lat - lat, p.lng - lng) > 3e-5);
    const drawn = addEdge(made.graph, from.id, made.nodeId, bends, { kind: drawing.kind, recordId: drawing.recordId }, login);
    commit(drawn?.graph ?? made.graph);
    setDrawing(drawing.kind === "slope" ? { ...drawing, anchor: made.nodeId, bends: [] } : null);
  };

  const patchEdge = (id: string, patch: Partial<GraphEdge>) =>
    commit(editPair(graph, id, (g) => ({ ...g, edges: g.edges.map((e) => (e.id === id ? { ...e, ...patch } : e)) })));

  const act = {
    flip: () => selectedEdge && patchEdge(selectedEdge.id, flipped(selectedEdge, login)),
    confirm: () => selectedEdge && patchEdge(selectedEdge.id, { provenance: { ...(selectedEdge.provenance ?? {}), ...userEdit(login) } }),
    twoWay: () => {
      if (!selectedEdge || selectedEdge.kind === "lift") return;
      // Already two-way: back to one way, keeping the direction shown as selected.
      if (selectedTwin) return commit({ ...graph, edges: graph.edges.filter((e) => e.id !== selectedTwin.id) });
      const back = reverseLink(selectedEdge, nodeById, graph.edges, login);
      if (back) commit({ ...graph, edges: [...graph.edges, back] });
    },
    remove: () => {
      if (selectedEdge) {
        const at = review.findIndex((r) => r.edgeId === selectedEdge.id);
        const after = at >= 0 ? review[at + 1]?.edgeId : undefined;
        commit(editPair(graph, selectedEdge.id, (g) => removeEdges(g, [selectedEdge.id])));
        setSelection(after ? { type: "edge", id: after } : null);
      } else if (selectedNode) {
        commit(removeNode(graph, selectedNode.id));
        setSelection(null);
      }
    },
    cut: () => setCutArmed((on) => !on),
    rejoin: () => {
      if (!selectedEdge) return;
      // Rejoining a two-way line rejoins both directions: drop the far piece's way back, join, and mirror the result.
      const far = continuation(graph, selectedEdge);
      const farTwin = far && twinOf(graph, far);
      const base: Graph = farTwin && selectedTwin ? { ...graph, edges: graph.edges.filter((e) => e.id !== farTwin.id) } : graph;
      let joinedId: string | null = null;
      const next = editPair(base, selectedEdge.id, (g) => {
        const joined = joinEdges(g, selectedEdge.id, login);
        joinedId = joined?.edgeId ?? null;
        return joined?.graph ?? g;
      });
      if (joinedId) {
        commit(next);
        setSelection({ type: "edge", id: joinedId });
      }
    },
    next: () => {
      if (review.length === 0) return;
      const at = review.findIndex((r) => r.edgeId === selectedEdge?.id);
      selectEdge(review[(at + 1) % review.length].edgeId, true);
    },
    assign: (recordId: string) => {
      if (!selectedEdge || selectedEdge.kind === "traverse") return;
      patchEdge(selectedEdge.id, {
        ...(selectedEdge.kind === "lift" ? { lift_id: recordId || null } : { slope_id: recordId || null }),
        provenance: { ...(selectedEdge.provenance ?? {}), ...userEdit(login) },
      });
    },
    escape: () => {
      if (drawing) setDrawing(null);
      else if (cutArmed) setCutArmed(false);
      else setSelection(null);
    },
  };
  const actRef = useRef(act);
  actRef.current = act;

  const measure = async () => {
    const points = positions(graph);
    setMeasuring("busy");
    try {
      const measured = new Map<string, number>();
      for (let at = 0; at < points.length; at += 400) {
        const chunk = points.slice(at, at + 400);
        const res = await fetch("/api/elevation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ points: chunk }) });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { elevations: number[] };
        chunk.forEach(([lat, lng], i) => measured.set(positionKey({ lat, lng }), body.elevations[i]));
      }
      const oriented = orientByElevation(graph, measured, login);
      commit(oriented.graph);
      setMeasuring({ flipped: oriented.flipped });
    } catch {
      setMeasuring("failed");
    }
  };

  // Handlers the map calls read the latest state through this ref: the
  // overlays are rebuilt on every change, but the map itself only once.
  const live = useRef({ graph, drawing, cutArmed, joinOnDrop, login, drawToNode, drawToLine, drawToNewNode, commit, selectEdge });
  live.current = { graph, drawing, cutArmed, joinOnDrop, login, drawToNode, drawToLine, drawToNewNode, commit, selectEdge };

  // ── keyboard ────────────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable) return;
      const a = actRef.current;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") { e.preventDefault(); undo(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "escape") a.escape();
      else if (key === "n") a.next();
      else if (key === "f") a.flip();
      else if (key === "t") a.twoWay();
      else if (key === "a") a.confirm();
      else if (key === "d" || key === "delete" || key === "backspace") a.remove();
      else if (key === "s") a.cut();
      else if (key === "j") a.rejoin();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [undo]);

  // ── map ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!mapEl.current || map.current) return;
    let cancelled = false;
    (async () => {
      try {
        if (!mapsConfigured) {
          setOptions({ key: webRuntimeConfig.mapApiKey, v: "weekly" });
          mapsConfigured = true;
        }
        const { Map } = (await importLibrary("maps")) as google.maps.MapsLibrary;
        await importLibrary("marker");
        if (cancelled || !mapEl.current) return;
        const m = new Map(mapEl.current, {
          center: KOREA, zoom: 8, mapTypeId: "terrain", clickableIcons: false, gestureHandling: "greedy",
          // Double-click belongs to drawing here; zoom with the wheel or the buttons.
          disableDoubleClickZoom: true,
          zoomControl: true, mapTypeControl: false, streetViewControl: false, fullscreenControl: false,
        });
        map.current = m;
        m.addListener("click", (e: google.maps.MapMouseEvent) => {
          const s = live.current;
          if (!e.latLng) return;
          if (s.drawing?.anchor) setDrawing({ ...s.drawing, bends: [...s.drawing.bends, { lat: e.latLng.lat(), lng: e.latLng.lng() }] });
          else if (!s.drawing) setSelection(null);
        });
        m.addListener("dblclick", (e: google.maps.MapMouseEvent) => {
          if (e.latLng && live.current.drawing) live.current.drawToNewNode(e.latLng.lat(), e.latLng.lng());
        });
        setMapReady(true);
      } catch (err) {
        setMapError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { map.current?.setMapTypeId(satellite ? "hybrid" : "terrain"); }, [satellite, mapReady]);
  useEffect(() => { map.current?.setOptions({ draggableCursor: drawing || cutArmed ? "crosshair" : undefined }); }, [drawing, cutArmed, mapReady]);
  useEffect(() => {
    if (!mapReady || !resort) return;
    const pts = graph.edges.length ? graph.edges.flatMap((e) => e.geometry) : records.flatMap((r) => r.coords);
    if (pts.length) fit(pts);
    else map.current?.setCenter({ lat: resort.place.coordinates.latitude, lng: resort.place.coordinates.longitude });
    // Only when a resort is opened, not on every edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resort, mapReady]);

  useEffect(() => {
    const m = map.current;
    if (!m || !mapReady) return;
    overlays.current.forEach((o) => o.setMap(null));
    overlays.current = [];

    // Catalog lines that the graph doesn't have yet: faint, as a reference to draw over or bring in.
    for (const r of records) {
      if (r.coords.length < 2 || pieceCount.has(recordKey(r.kind, r.id))) continue;
      const on = highlighted === recordKey(r.kind, r.id);
      const line = new google.maps.Polyline({
        map: m, path: r.coords, strokeOpacity: 0, clickable: true, zIndex: 1,
        icons: [{ icon: { path: "M 0,-1 0,1", strokeOpacity: on ? 1 : 0.55, strokeColor: on ? SELECTED : "#6b7280", scale: on ? 4 : 2.5 }, offset: "0", repeat: "10px" }],
      });
      line.addListener("click", () => { if (!live.current.drawing) setSelection({ type: "record", id: recordKey(r.kind, r.id) }); });
      overlays.current.push(line);
    }

    for (const e of graph.edges) {
      // A two-way line is drawn once, with an arrow each way.
      const twin = twinOf(graph, e);
      if (twin && twin.id < e.id) continue;
      const rec = e.kind === "traverse" ? undefined : recordByKey.get(recordKey(e.kind, (e.kind === "slope" ? e.slope_id : e.lift_id) ?? ""));
      const selected = selection?.type === "edge" && selection.id === e.id;
      const inRecord = rec != null && highlighted === recordKey(rec.kind, rec.id);
      const source = e.provenance?.source ?? "osm";
      const colour = selected ? SELECTED : e.kind === "lift" ? LIFT : e.kind === "traverse" ? LINK[source] : SLOPE;
      const weight = selected ? 6 : inRecord ? 5 : e.kind === "traverse" ? 2.5 : 3.5;
      const dashed = !selected && (e.kind === "lift" || (e.kind === "traverse" && source === "suggested"));
      const arrow = { path: google.maps.SymbolPath.FORWARD_CLOSED_ARROW, scale: selected ? 4 : 2.6, strokeColor: colour, fillColor: colour, fillOpacity: 1, strokeOpacity: 1 };
      const line = new google.maps.Polyline({
        map: m,
        path: e.geometry.map((p) => ({ lat: p.lat, lng: p.lng })),
        strokeColor: colour,
        strokeOpacity: dashed ? 0 : selected || inRecord ? 1 : 0.9,
        strokeWeight: weight,
        editable: selected && !drawing && !cutArmed,
        clickable: true,
        zIndex: selected ? 40 : inRecord ? 30 : e.kind === "traverse" ? 12 : 20,
        icons: [
          ...(dashed ? [{ icon: { path: "M 0,-1 0,1", strokeOpacity: 1, strokeColor: colour, scale: weight }, offset: "0", repeat: "12px" }] : []),
          { icon: arrow, offset: twin ? "62%" : "55%" },
          ...(twin ? [{ icon: { ...arrow, path: google.maps.SymbolPath.BACKWARD_CLOSED_ARROW }, offset: "38%" }] : []),
        ],
      });
      line.addListener("click", (ev: google.maps.MapMouseEvent) => {
        const s = live.current;
        if (!ev.latLng) return;
        if (s.cutArmed) {
          const at = { lat: ev.latLng.lat(), lng: ev.latLng.lng() };
          let nodeId: string | null = null;
          const next = editPair(s.graph, e.id, (g) => {
            const cut = splitEdge(g, e.id, at.lat, at.lng, s.login);
            nodeId = cut?.nodeId ?? null;
            return cut?.graph ?? g;
          });
          setCutArmed(false);
          if (nodeId) { s.commit(next); setSelection({ type: "node", id: nodeId }); }
        } else if (s.drawing) {
          if (e.kind !== "traverse") s.drawToLine(e.id, ev.latLng.lat(), ev.latLng.lng());
        } else {
          setSelection({ type: "edge", id: e.id });
        }
      });
      if (selected && !drawing && !cutArmed) {
        // Dragging a point of the selected line reshapes it; its ends stay on their nodes.
        const path = line.getPath();
        const sync = () => {
          const shape = path.getArray().map((p) => ({ lat: p.lat(), lng: p.lng() }));
          live.current.commit(editPair(live.current.graph, e.id, (g) => reshapeEdge(g, e.id, shape, live.current.login)));
        };
        google.maps.event.addListener(path, "set_at", sync);
        google.maps.event.addListener(path, "insert_at", sync);
        google.maps.event.addListener(path, "remove_at", sync);
      }
      overlays.current.push(line);
    }

    for (const n of graph.nodes) {
      const selected = selection?.type === "node" && selection.id === n.id;
      const anchor = drawing?.anchor === n.id;
      const marker = new google.maps.Marker({
        map: m,
        position: { lat: n.lat, lng: n.lng },
        draggable: selected && !drawing,
        zIndex: selected || anchor ? 60 : 50,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: selected || anchor ? 8 : drawing ? 6 : 4,
          fillColor: anchor ? "#facc15" : selected ? SELECTED : "#ffffff",
          fillOpacity: 1,
          strokeColor: "#111827",
          strokeWeight: selected || anchor ? 2 : 1.2,
        },
      });
      marker.addListener("click", () => {
        if (live.current.drawing) live.current.drawToNode(n.id);
        else setSelection({ type: "node", id: n.id });
      });
      marker.addListener("dragend", (ev: google.maps.MapMouseEvent) => {
        const s = live.current;
        if (!ev.latLng) return;
        const lat = ev.latLng.lat();
        const lng = ev.latLng.lng();
        const shift = (ev.domEvent as MouseEvent | undefined)?.shiftKey === true;
        if (s.joinOnDrop || shift) {
          const dropped = dropNode(s.graph, n.id, lat, lng, s.login);
          s.commit(dropped.graph);
          setSelection({ type: "node", id: dropped.intoId ?? n.id });
        } else {
          s.commit(moveNode(s.graph, n.id, lat, lng));
        }
      });
      overlays.current.push(marker);
    }

    // The line being drawn, from its start through the bends so far.
    const from = drawing?.anchor ? nodeById.get(drawing.anchor) : undefined;
    if (from && drawing && drawing.bends.length) {
      overlays.current.push(new google.maps.Polyline({
        map: m, path: [{ lat: from.lat, lng: from.lng }, ...drawing.bends], strokeColor: "#facc15", strokeWeight: 4, clickable: false, zIndex: 70,
      }));
    }
  }, [graph, selection, drawing, cutArmed, highlighted, records, recordByKey, pieceCount, nodeById, mapReady]);

  // ── saving ──────────────────────────────────────────────────────────

  const bundle: PatchBundle | null = useMemo(() => {
    if (!resort) return null;
    const base = resort.graph;
    const baseEdges = new Map((base?.edges ?? []).map((e) => [e.id, e]));
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const unchanged =
      base != null && base.nodes.length === graph.nodes.length && base.edges.length === graph.edges.length &&
      graph.edges.every((e) => same(baseEdges.get(e.id), e)) && same(base.nodes, graph.nodes);
    const recordsTouched = addedSlopes.length + addedLifts.length + Object.keys(recordEdits).length + removedRecords.length > 0;
    if ((unchanged && !recordsTouched) || graph.edges.length === 0 || graph.nodes.length < 2) return null;

    // An edge a person moved is theirs, even if only its points were dragged.
    const line = (e: GraphEdge) => e.geometry.map((v) => `${v.lat},${v.lng}`).join(" ");
    const edges = graph.edges.map((e) => {
      const was = baseEdges.get(e.id);
      const byHand = was != null && (was.from !== e.from || was.to !== e.to || was.kind !== e.kind || line(was) !== line(e));
      return byHand && e.provenance?.source !== "user-edit" ? { ...e, provenance: { ...(e.provenance ?? {}), ...userEdit(login) } } : e;
    });
    const files: Record<string, string> = {};
    files["slope-graph.json"] = JSON.stringify({
      $schema: "../../../../schemas/slope-graph.schema.json",
      ...(base ?? {}),
      place_slug: resort.ref.slug,
      version: Math.max(2, base?.version ?? 2),
      nodes: graph.nodes,
      edges,
    }, null, 2) + "\n";

    // A slope's or lift's own line in the catalog follows its pieces, so nothing is left "without geometry".
    const edgeById = new Map(edges.map((e) => [e.id, e]));
    const derive = <T extends SlopeRecord | LiftRecord>(kind: "slope" | "lift", list: T[], added: number): { list: T[]; changed: boolean } => {
      const before = list.length;
      list = list.filter((r) => !removedRecords.includes(`${kind}:${r.id}`));
      let changed = added > 0 || list.length !== before;
      const next = list.map((given) => {
        const edit = recordEdits[`${kind}:${given.id}`];
        const r: T = edit
          ? { ...given, ...(edit.name ? { name_i18n: { ...(given.name_i18n ?? {}), [locale]: edit.name } } : {}), ...(edit.difficulty ? { difficulty: edit.difficulty } : {}), ...(edit.type ? { type: edit.type } : {}) }
          : given;
        if (edit) changed = true;
        const pieces = piecesOf({ nodes: graph.nodes, edges }, kind, r.id);
        if (pieces.length === 0) return r;
        const coordinates = stitchEdges(pieces.map((p) => p.id), edgeById);
        const before = (r.coordinates ?? []).map((c) => `${c.lat},${c.lon}`).join(" ");
        if (coordinates.length < 2 || before === coordinates.map((c) => `${c.lat},${c.lon}`).join(" ")) return r;
        changed = true;
        return { ...r, coordinates };
      });
      return { list: next, changed };
    };
    const head = { country_code: resort.ref.countryCode, region_slug: resort.ref.regionSlug, place_slug: resort.ref.slug };
    const slopes = derive("slope", [...resort.slopes, ...addedSlopes], addedSlopes.length);
    if (slopes.changed) {
      const clean = slopes.list.map((s) => {
        if (s.difficulty !== null) return s;
        const { difficulty: _none, ...rest } = s;
        void _none;
        return rest;
      });
      files["slopes.json"] = JSON.stringify({ $schema: "../../../schemas/slope.schema.json", ...head, slopes: clean }, null, 2) + "\n";
    }
    const lifts = derive("lift", [...resort.lifts, ...addedLifts], addedLifts.length);
    if (lifts.changed) files["lifts.json"] = JSON.stringify({ $schema: "../../../schemas/lift.schema.json", ...head, lifts: lifts.list }, null, 2) + "\n";

    return { slug: resort.ref.slug, countryCode: resort.ref.countryCode, regionSlug: resort.ref.regionSlug, files, message: `graph-editor: ${resort.ref.slug}` };
  }, [resort, graph, login, addedSlopes, addedLifts, recordEdits, removedRecords, locale]);

  // ── view ────────────────────────────────────────────────────────────

  const shown = records.filter((r) => !search.trim() || r.name.toLowerCase().includes(search.trim().toLowerCase()));
  const button = "min-h-11 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--border-strong)] disabled:opacity-40";
  const primary = "min-h-11 rounded-md bg-[var(--accent)] px-3 text-sm font-bold text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-40";
  const linesFor = selectedEdge && selectedEdge.kind !== "traverse" ? records.filter((r) => r.kind === selectedEdge.kind) : [];

  return (
    <section className="relative h-[100dvh] w-full overflow-hidden bg-[var(--bg-page)] text-[var(--fg)]">
      <div className="absolute inset-0">
        {mapError ? (
          <p className="grid h-full place-items-center p-6 text-center text-sm">{t("mapFailed")}: {mapError}</p>
        ) : (
          <div ref={mapEl} className="h-full w-full" aria-label={t("mapLabel")} />
        )}
      </div>

      {(drawing || cutArmed) && (
        <p role="status" className="pointer-events-none absolute left-1/2 top-3 z-20 max-w-[min(34rem,60vw)] -translate-x-1/2 rounded-md bg-amber-300 px-4 py-2 text-center text-sm font-bold text-black shadow">
          {cutArmed ? t("hintCut") : drawing?.anchor ? t("hintDrawing", { count: drawing.bends.length }) : t("hintDrawStart")}
          <span className="ml-2 font-normal">{t("hintEsc")}</span>
        </p>
      )}

      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        aria-expanded={!collapsed}
        className={`absolute z-20 grid min-h-11 min-w-11 place-items-center rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev)] px-3 text-sm font-bold text-[var(--fg)] shadow-lg ${collapsed ? "bottom-2 right-2 md:bottom-auto md:top-14" : "bottom-[55%] right-3 md:bottom-auto md:right-[27.5rem] md:top-14"}`}
      >
        {collapsed ? t("showPanel") : t("hidePanel")}
      </button>
      <aside className={`${collapsed ? "hidden" : "flex"} absolute inset-x-2 bottom-2 top-[45%] z-10 flex-col gap-3 overflow-y-auto rounded-lg bg-[var(--bg-elev)] p-3 shadow-xl md:bottom-2 md:left-auto md:right-2 md:top-14 md:w-[26rem]`}>
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-base font-bold">{t("title")}</h1>
          <div className="flex items-center gap-2">
            <button type="button" className={button} onClick={() => setSatellite((s) => !s)}>{satellite ? t("terrain") : t("satellite")}</button>
            <Link href="/editor" className="text-sm font-semibold text-[var(--accent)] underline">{t("oldEditor")}</Link>
          </div>
        </header>

        <ResortPicker current={resort} onLoad={setResort} t={t} />

        {resort && (
          <>
            {/* What is selected, and what you can do to it. */}
            {selectedEdge && (
              <section className="rounded-md border-2 border-cyan-500 bg-cyan-500/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-bold">{edgeName(selectedEdge)}</p>
                    <p className="text-sm text-[var(--fg-muted)]">
                      {t(selectedEdge.kind === "slope" ? "slopePiece" : selectedEdge.kind === "lift" ? "liftPiece" : "link")}
                      {selectedEdge.length_m ? ` · ${Math.round(selectedEdge.length_m)} m` : ""}{selectedTwin ? ` · ${t("bothWays")}` : ""} · {originText(t, selectedEdge)}
                    </p>
                  </div>
                  <button type="button" onClick={() => setSelection(null)} aria-label={t("close")} className="min-h-11 px-2 text-lg">✕</button>
                </div>
                {selectedEdge.kind !== "traverse" && (
                  <label className="mt-2 block text-sm text-[var(--fg-muted)]">
                    {t(selectedEdge.kind === "lift" ? "belongsLift" : "belongsSlope")}
                    <select
                      value={(selectedEdge.kind === "lift" ? selectedEdge.lift_id : selectedEdge.slope_id) ?? ""}
                      onChange={(e) => act.assign(e.target.value)}
                      className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-2 text-sm"
                    >
                      <option value="">{t("none")}</option>
                      {linesFor.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </label>
                )}
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <button type="button" className={button} onClick={act.flip} disabled={selectedTwin != null}>{t("flip")} <kbd className="opacity-60">F</kbd></button>
                  <button type="button" className={button} onClick={act.cut} disabled={selectedEdge.kind === "traverse"}>{t("cut")} <kbd className="opacity-60">S</kbd></button>
                  <button type="button" className={button} onClick={act.rejoin} disabled={!continuation(graph, selectedEdge)}>{t("rejoin")} <kbd className="opacity-60">J</kbd></button>
                  <button type="button" className={button} onClick={act.twoWay} disabled={selectedEdge.kind === "lift"} aria-pressed={selectedTwin != null}>{selectedTwin ? t("oneWay") : t("twoWay")} <kbd className="opacity-60">T</kbd></button>
                  <button type="button" className={button} onClick={act.confirm} disabled={selectedEdge.provenance?.source === "user-edit"}>{t("confirm")} <kbd className="opacity-60">A</kbd></button>
                  <button type="button" className="min-h-11 rounded-md border border-red-500 bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold text-red-500 hover:bg-red-500/10" onClick={act.remove}>{t("delete")} <kbd className="opacity-60">D</kbd></button>
                </div>
                <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("edgeHint")}</p>
              </section>
            )}
            {selectedNode && (
              <section className="rounded-md border-2 border-cyan-500 bg-cyan-500/10 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-base font-bold">{t("node")}</p>
                    <p className="text-sm text-[var(--fg-muted)]">{Math.round(selectedNode.alt_m)} m · {nodeNames(graph, selectedNode.id, edgeName) || t("nodeUnused")}</p>
                  </div>
                  <button type="button" onClick={() => setSelection(null)} aria-label={t("close")} className="min-h-11 px-2 text-lg">✕</button>
                </div>
                <label className="mt-2 block text-sm text-[var(--fg-muted)]">
                  {t("nodeKind")}
                  <select
                    value={selectedNode.kind ?? "waypoint"}
                    onChange={(e) => commit({ ...graph, nodes: graph.nodes.map((n) => (n.id === selectedNode.id ? { ...n, kind: e.target.value as GraphNode["kind"] } : n)) })}
                    className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-2 text-sm text-[var(--fg)]"
                  >
                    {NODE_KINDS.map((k) => <option key={k} value={k}>{t(`nodeKind_${k}`)}</option>)}
                  </select>
                </label>
                <label className="mt-2 flex min-h-11 items-center gap-3 text-sm font-semibold">
                  <input type="checkbox" checked={joinOnDrop} onChange={(e) => setJoinOnDrop(e.target.checked)} className="h-5 w-5" />
                  {t("joinToggle")}
                </label>
                <p className="text-sm text-[var(--fg-muted)]">{joinOnDrop ? t("joinOn") : t("joinOff")}</p>
                <button type="button" className="mt-2 min-h-11 rounded-md border border-red-500 bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold text-red-500 hover:bg-red-500/10" onClick={act.remove}>{t("deleteNode")}</button>
              </section>
            )}
            {selectedRecord && !selectedNode && (
              <section className="rounded-md border border-[var(--border-strong)] p-3">
                <p className="text-base font-bold">{selectedRecord.name}</p>
                <p className="text-sm text-[var(--fg-muted)]">
                  {t(selectedRecord.kind === "lift" ? "lift" : "slope")} · {pieceCount.get(recordKey(selectedRecord.kind, selectedRecord.id))
                    ? t("pieces", { count: pieceCount.get(recordKey(selectedRecord.kind, selectedRecord.id)) ?? 0 })
                    : t("noLine")}
                </p>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label className="text-sm text-[var(--fg-muted)]">
                    {t("name")}
                    <input
                      value={selectedRecord.name}
                      onChange={(e) => setRecordEdits((m) => ({ ...m, [recordKey(selectedRecord.kind, selectedRecord.id)]: { ...m[recordKey(selectedRecord.kind, selectedRecord.id)], name: e.target.value } }))}
                      className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] px-2 text-sm text-[var(--fg)]"
                    />
                  </label>
                  {selectedRecord.kind === "slope" && (
                    <label className="text-sm text-[var(--fg-muted)]">
                      {t("grade")}
                      <select
                        value={selectedRecord.difficulty ?? ""}
                        onChange={(e) => setRecordEdits((m) => ({ ...m, [recordKey("slope", selectedRecord.id)]: { ...m[recordKey("slope", selectedRecord.id)], difficulty: e.target.value } }))}
                        className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-2 text-sm text-[var(--fg)]"
                      >
                        <option value="">{t("none")}</option>
                        {GRADES.map((g) => <option key={g} value={g}>{t(`grade_${g}`)}</option>)}
                      </select>
                    </label>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <button type="button" className={primary} onClick={() => startDrawing(selectedRecord.kind, selectedRecord.id)}>{t("drawThis")}</button>
                  {!pieceCount.get(recordKey(selectedRecord.kind, selectedRecord.id)) && selectedRecord.coords.length >= 2 && (
                    <button
                      type="button"
                      className={button}
                      onClick={() => {
                        const brought = importLine(graph, selectedRecord.coords, { kind: selectedRecord.kind, recordId: selectedRecord.id }, login);
                        if (brought) { commit(brought.graph); setSelection({ type: "edge", id: brought.edgeId }); }
                      }}
                    >
                      {t("useCatalogLine")}
                    </button>
                  )}
                  <button type="button" className="min-h-11 rounded-md border border-red-500 bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold text-red-500 hover:bg-red-500/10" onClick={() => removeRecord(selectedRecord)}>
                    {t(selectedRecord.kind === "lift" ? "deleteLift" : "deleteSlope")}
                  </button>
                </div>
              </section>
            )}

            {adding && <NewRecordForm kind={adding} t={t} onCancel={() => setAdding(null)} onAdd={(name, grade) => addRecord(adding, name, grade)} />}
            <div className="flex flex-wrap gap-2">
              <button type="button" className={button} onClick={() => setAdding("slope")}>{t("addSlope")}</button>
              <button type="button" className={button} onClick={() => setAdding("lift")}>{t("addLift")}</button>
              <button type="button" className={button} onClick={() => startDrawing("traverse", null)}>{t("drawLink")}</button>
              <button type="button" className={button} onClick={undo} disabled={history.length === 0}>{t("undo")} ({history.length})</button>
            </div>

            {/* One list: every slope and lift, with or without a line. */}
            <section>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t("search")}
                className="mb-2 block min-h-11 w-full rounded-md border border-[var(--border-strong)] px-3 text-sm"
              />
              <ul className="max-h-72 space-y-1 overflow-y-auto">
                {shown.map((r) => {
                  const key = recordKey(r.kind, r.id);
                  const count = pieceCount.get(key) ?? 0;
                  const on = highlighted === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => selectRecord(r)}
                        aria-current={on}
                        className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${on ? "bg-cyan-500/25 font-bold" : "hover:bg-[var(--border-strong)]"}`}
                      >
                        <span aria-hidden="true" className="h-3 w-3 flex-none rounded-full" style={{ background: r.kind === "lift" ? LIFT : SLOPE }} />
                        <span className="min-w-0 flex-1 truncate">{r.name}</span>
                        <span className="flex-none text-xs text-[var(--fg-muted)]">{t(r.kind === "lift" ? "lift" : "slope")}</span>
                        <span className={`flex-none text-xs ${count ? "text-[var(--fg-muted)]" : "font-bold text-amber-500"}`}>{count ? t("pieces", { count }) : t("noLine")}</span>
                      </button>
                    </li>
                  );
                })}
                {shown.length === 0 && <li className="px-2 text-sm text-[var(--fg-muted)]">{t("nothingFound")}</li>}
              </ul>
            </section>

            {/* Things worth a look, and the two clean-ups. */}
            <details className="rounded-md border border-[var(--border-strong)] p-3">
              <summary className="min-h-11 cursor-pointer text-sm font-bold leading-[2.75rem]">{t("checks", { count: review.length + near.length + redundant.length + stranded.length })}</summary>
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" className={button} onClick={measure} disabled={measuring === "busy" || graph.edges.length === 0}>
                    {measuring === "busy" ? t("measuring") : t("measure")}
                  </button>
                  <span role="status" className="text-sm text-[var(--fg-muted)]">
                    {measuring === "failed" ? t("measureFailed") : typeof measuring === "object" ? t("measured", { count: measuring.flipped }) : ""}
                  </span>
                </div>
                {redundant.length > 0 && (
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={button} onClick={() => commit(removeEdges(graph, redundant))}>{t("removeRedundant", { count: redundant.length })}</button>
                    <span className="text-sm text-[var(--fg-muted)]">{t("redundantWhy")}</span>
                  </div>
                )}
                {stranded.length > 0 && (
                  <div>
                    <p className="text-sm font-bold">{t("stranded", { count: stranded.length })}</p>
                    <p className="text-sm text-[var(--fg-muted)]">{t("strandedWhy")}</p>
                    <ul className="max-h-40 overflow-y-auto">
                      {stranded.map((e) => (
                        <li key={e.id}>
                          <button type="button" className="min-h-11 w-full truncate text-left text-sm underline" onClick={() => selectEdge(e.id, true)}>{edgeName(e)}</button>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {near.map((p) => (
                  <div key={`${p.a}-${p.b}`} className="flex items-center gap-2 text-sm">
                    <button type="button" className="min-h-11 flex-1 truncate text-left underline" onClick={() => { setSelection({ type: "node", id: p.a }); const n = nodeById.get(p.a); if (n) map.current?.panTo({ lat: n.lat, lng: n.lng }); }}>
                      {t("nearPair", { m: p.distM })}
                    </button>
                    <button type="button" className={button} onClick={() => { commit(mergeNode(graph, p.a, p.b)); setSelection({ type: "node", id: p.b }); }}>{t("weld")}</button>
                  </div>
                ))}
                <ol className="max-h-56 space-y-1 overflow-y-auto">
                  {review.map((item, i) => {
                    const e = graph.edges.find((x) => x.id === item.edgeId);
                    if (!e) return null;
                    return (
                      <li key={item.edgeId}>
                        <button type="button" onClick={() => selectEdge(item.edgeId, true)} className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${selectedEdge?.id === item.edgeId ? "bg-cyan-500/25" : "hover:bg-[var(--border-strong)]"}`}>
                          <span className="w-6 flex-none text-right tabular-nums">{i + 1}</span>
                          <span className="min-w-0 flex-1 truncate">{edgeName(e)}</span>
                          <span className="flex-none text-xs">{t(item.reason === "suggested" ? "reasonSuggested" : item.reason === "weak" ? "reasonWeak" : "reasonDirection")}</span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              </div>
            </details>

            <PatchSaver bundle={bundle} />
          </>
        )}
      </aside>
    </section>
  );
}

const NODE_KINDS = ["waypoint", "fork", "merge", "lift_bottom", "lift_station", "lift_top", "summit", "base"] as const;
const GRADES = ["beginner", "beginner_intermediate", "intermediate", "intermediate_advanced", "advanced", "expert", "terrain_park"] as const;
const LIFT_TYPES = ["chair_lift", "gondola", "magic_carpet", "drag_lift", "cable_car"] as const;

/** Name and grade (or lift type) for a slope or lift the catalog doesn't have yet. */
function NewRecordForm({ kind, t, onAdd, onCancel }: { kind: "slope" | "lift"; t: ReturnType<typeof useTranslations>; onAdd: (name: string, grade: string) => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [grade, setGrade] = useState<string>(kind === "slope" ? "intermediate" : "chair_lift");
  return (
    <form
      className="rounded-md border border-[var(--border-strong)] p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) onAdd(name.trim(), grade);
      }}
    >
      <p className="text-base font-bold">{t(kind === "slope" ? "addSlope" : "addLift")}</p>
      <label className="mt-2 block text-sm text-[var(--fg-muted)]">
        {t("name")}
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] px-2 text-sm text-[var(--fg)]" />
      </label>
      <label className="mt-2 block text-sm text-[var(--fg-muted)]">
        {t(kind === "slope" ? "grade" : "liftType")}
        <select value={grade} onChange={(e) => setGrade(e.target.value)} className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-2 text-sm text-[var(--fg)]">
          {(kind === "slope" ? GRADES : LIFT_TYPES).map((g) => <option key={g} value={g}>{t(kind === "slope" ? `grade_${g}` : `liftType_${g}`)}</option>)}
        </select>
      </label>
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={!name.trim()} className="min-h-11 rounded-md bg-[var(--accent)] px-3 text-sm font-bold text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-40">{t("addAndDraw")}</button>
        <button type="button" onClick={onCancel} className="min-h-11 rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--border-strong)]">{t("cancel")}</button>
      </div>
    </form>
  );
}

function originText(t: ReturnType<typeof useTranslations>, e: GraphEdge): string {
  const p = e.provenance;
  if (p?.source === "suggested") return t("originSuggested");
  if (p?.source === "observed") return t("originObserved", { count: p.observed_count ?? 0 });
  if (p?.source === "user-edit") return p.contributor ? t("originUser", { who: p.contributor }) : t("originUserAnon");
  if (p?.source === "osm") return t("originOsm", { count: p.observed_count ?? 0 });
  return t("originUnknown");
}

/** What meets at a node, by name: "골드 · 골드 파라다이스". */
function nodeNames(g: Graph, nodeId: string, name: (e: GraphEdge) => string): string {
  const names = new Set<string>();
  for (const e of g.edges) if (e.kind !== "traverse" && (e.from === nodeId || e.to === nodeId)) names.add(name(e));
  return [...names].join(" · ");
}

/** Find a resort by typing: there are too many for a dropdown. */
function ResortPicker({ current, onLoad, t }: { current: LoadedResort | null; onLoad: (r: LoadedResort | null) => void; t: ReturnType<typeof useTranslations> }) {
  const [refs, setRefs] = useState<ResortRef[] | null>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(true);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  useEffect(() => {
    fetchManifest().then(setRefs).catch(() => setRefs([]));
  }, []);

  const pick = async (ref: ResortRef) => {
    setState("loading");
    try {
      const loaded = await loadResort(ref);
      onLoad(loaded);
      setState(loaded ? "idle" : "failed");
      if (loaded) { setOpen(false); setQuery(""); }
    } catch {
      setState("failed");
    }
  };

  if (current && !open) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-[var(--border-strong)] p-3">
        <p className="min-w-0 truncate text-base font-bold">{current.place.name} <span className="text-sm font-normal text-[var(--fg-muted)]">{current.ref.countryCode}/{current.ref.regionSlug}</span></p>
        <button type="button" onClick={() => setOpen(true)} className="min-h-11 flex-none rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-3 text-sm font-semibold">{t("changeResort")}</button>
      </div>
    );
  }
  const q = query.trim().toLowerCase();
  const matches = (refs ?? []).filter((r) => !q || r.label.toLowerCase().includes(q));
  return (
    <div className="rounded-md border border-[var(--border-strong)] p-3">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("findResort")}
        aria-label={t("findResort")}
        className="block min-h-11 w-full rounded-md border border-[var(--border-strong)] bg-[var(--bg-elev-strong)] px-3 text-sm text-[var(--fg)]"
      />
      <p role="status" className="mt-1 text-sm text-[var(--fg-muted)]">
        {refs === null ? t("loadingResorts") : state === "loading" ? t("openingResort") : state === "failed" ? t("resortFailed") : t("resortCount", { count: matches.length })}
      </p>
      <ul className="mt-1 max-h-56 overflow-y-auto">
        {matches.map((r) => (
          <li key={`${r.countryCode}/${r.regionSlug}/${r.slug}`}>
            <button type="button" onClick={() => void pick(r)} className="min-h-11 w-full truncate rounded-md px-2 text-left text-sm hover:bg-[var(--border-strong)]">{r.label}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
