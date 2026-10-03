/**
 * Structural edits to a slope graph, as pure functions over the whole
 * graph: cut an edge, weld one node into another, drop a node somewhere
 * (which welds or cuts as needed), and rejoin two pieces. The editor
 * hands in the graph as it stands and stores what comes back.
 *
 * Schema rule kept throughout: an edge's first vertex sits on its `from`
 * node and its last on its `to` node.
 */

import { distanceM } from "./geo";
import { userEdit } from "./graph-review";
import type { GraphEdge, GraphNode } from "./resort-loader";

export type Graph = { nodes: GraphNode[]; edges: GraphEdge[] };
type Vertex = GraphEdge["geometry"][number];

/** Dropping a node this close to another node, or to an edge, joins them. */
export const JOIN_M = 20;

const uid = (prefix: string) => `${prefix}-u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function lengthM(geometry: Vertex[]): number {
  let m = 0;
  for (let i = 1; i < geometry.length; i++) m += distanceM(geometry[i - 1], geometry[i]);
  return Math.round(m * 10) / 10;
}

/** The point of an edge nearest to a position: the segment it falls on, the point itself, and how far away it is. */
export function nearestOnEdge(edge: GraphEdge, lat: number, lng: number): { segment: number; point: Vertex; distM: number } | null {
  let best: { segment: number; point: Vertex; distM: number } | null = null;
  const k = Math.cos((lat * Math.PI) / 180);
  for (let i = 1; i < edge.geometry.length; i++) {
    const a = edge.geometry[i - 1];
    const b = edge.geometry[i];
    const dx = (b.lng - a.lng) * k;
    const dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (((lng - a.lng) * k) * dx + (lat - a.lat) * dy) / len2));
    const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, alt_m: Math.round((a.alt_m + (b.alt_m - a.alt_m) * t) * 10) / 10 };
    const distM = distanceM(point, { lat, lng });
    if (!best || distM < best.distM) best = { segment: i, point, distM };
  }
  return best;
}

/**
 * Cut an edge in two at the point nearest a position. The pieces keep the
 * edge's slope or lift, and a new node sits at the cut. Cutting at an end
 * does nothing.
 */
export function splitEdge(g: Graph, edgeId: string, lat: number, lng: number, contributor?: string): { graph: Graph; nodeId: string } | null {
  const edge = g.edges.find((e) => e.id === edgeId);
  const at = edge && nearestOnEdge(edge, lat, lng);
  if (!edge || !at) return null;
  const first = edge.geometry[0];
  const last = edge.geometry[edge.geometry.length - 1];
  if (distanceM(at.point, first) < 1 || distanceM(at.point, last) < 1) return null;
  const node: GraphNode = { id: uid("n"), lat: at.point.lat, lng: at.point.lng, alt_m: at.point.alt_m, kind: "waypoint" };
  // A cut exactly at a bend must not leave that bend twice in a piece.
  const same = (p: Vertex) => p.lat === at.point.lat && p.lng === at.point.lng;
  const upper = [...edge.geometry.slice(0, at.segment).filter((p) => !same(p)), at.point];
  const lower = [at.point, ...edge.geometry.slice(at.segment).filter((p) => !same(p))];
  const piece = (from: string, to: string, geometry: Vertex[]): GraphEdge => ({
    ...edge,
    id: uid("e"),
    from,
    to,
    geometry,
    length_m: lengthM(geometry),
    provenance: { ...(edge.provenance ?? {}), ...userEdit(contributor) },
  });
  return {
    nodeId: node.id,
    graph: {
      nodes: [...g.nodes, node],
      edges: [...g.edges.filter((e) => e.id !== edgeId), piece(edge.from, node.id, upper), piece(node.id, edge.to, lower)],
    },
  };
}

/**
 * Weld `removeId` into `keepId`: every edge that used the removed node
 * now uses the kept one, with its end moved there. An edge left running
 * from a node to itself is dropped, as is the second of two identical links.
 */
export function mergeNode(g: Graph, removeId: string, keepId: string): Graph {
  const keep = g.nodes.find((n) => n.id === keepId);
  if (!keep || removeId === keepId) return g;
  const at = { lat: keep.lat, lng: keep.lng, alt_m: keep.alt_m };
  const seenLinks = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const e of g.edges) {
    let next = e;
    if (e.from === removeId || e.to === removeId) {
      const geometry = e.geometry.slice();
      if (e.from === removeId) geometry[0] = at;
      if (e.to === removeId) geometry[geometry.length - 1] = at;
      next = { ...e, from: e.from === removeId ? keepId : e.from, to: e.to === removeId ? keepId : e.to, geometry, length_m: lengthM(geometry) };
    }
    if (next.from === next.to) continue;
    if (next.kind === "traverse") {
      const key = `${next.from}>${next.to}`;
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
    }
    edges.push(next);
  }
  return { nodes: g.nodes.filter((n) => n.id !== removeId), edges };
}

/** Move a node, taking the ends of its edges with it. */
export function moveNode(g: Graph, nodeId: string, lat: number, lng: number): Graph {
  const node = g.nodes.find((n) => n.id === nodeId);
  if (!node) return g;
  const at = { lat, lng, alt_m: node.alt_m };
  return {
    nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, lat, lng } : n)),
    edges: g.edges.map((e) => {
      if (e.from !== nodeId && e.to !== nodeId) return e;
      const geometry = e.geometry.slice();
      if (e.from === nodeId) geometry[0] = at;
      if (e.to === nodeId) geometry[geometry.length - 1] = at;
      return { ...e, geometry, length_m: lengthM(geometry) };
    }),
  };
}

export type Drop = { graph: Graph; did: "merged" | "cut" | "moved"; intoId?: string };

/**
 * Let go of a dragged node. On another node: the two become one (a lift's
 * top becomes a slope's start). On the middle of an edge: the edge is cut
 * there and the node welded to the cut (a slope leaving another slope
 * part-way down). Anywhere else: it just moves.
 */
export function dropNode(g: Graph, nodeId: string, lat: number, lng: number, contributor?: string): Drop {
  let nearNode: { id: string; d: number } | null = null;
  for (const n of g.nodes) {
    if (n.id === nodeId) continue;
    const d = distanceM(n, { lat, lng });
    if (d <= JOIN_M && (!nearNode || d < nearNode.d)) nearNode = { id: n.id, d };
  }
  if (nearNode) return { graph: mergeNode(g, nodeId, nearNode.id), did: "merged", intoId: nearNode.id };

  // Slopes run under lifts all over a resort, so a slope within reach wins
  // over a lift line; a lift is only cut (a mid-station) when no slope is near.
  let nearEdge: { id: string; d: number; lift: boolean } | null = null;
  for (const e of g.edges) {
    if (e.from === nodeId || e.to === nodeId || e.kind === "traverse") continue;
    const at = nearestOnEdge(e, lat, lng);
    if (!at || at.distM > JOIN_M) continue;
    const lift = e.kind === "lift";
    if (!nearEdge || (nearEdge.lift && !lift) || (nearEdge.lift === lift && at.distM < nearEdge.d)) nearEdge = { id: e.id, d: at.distM, lift };
  }
  if (nearEdge) {
    const cut = splitEdge(g, nearEdge.id, lat, lng, contributor);
    if (cut) return { graph: mergeNode(cut.graph, nodeId, cut.nodeId), did: "cut", intoId: cut.nodeId };
  }
  return { graph: moveNode(g, nodeId, lat, lng), did: "moved" };
}

/** The one edge that carries on from this edge's end as the same slope or lift, if there is exactly one. */
export function continuation(g: Graph, edge: GraphEdge): GraphEdge | null {
  if (edge.kind === "traverse") return null;
  const own = edge.slope_id ?? edge.lift_id ?? null;
  const next = g.edges.filter((e) => e.id !== edge.id && e.from === edge.to && e.kind === edge.kind && (e.slope_id ?? e.lift_id ?? null) === own);
  return next.length === 1 ? next[0] : null;
}

/**
 * Undo a cut: the edge and the piece that carries on from it become one
 * edge again. The node between them goes too, unless something else uses it.
 */
export function joinEdges(g: Graph, edgeId: string, contributor?: string): { graph: Graph; edgeId: string } | null {
  const edge = g.edges.find((e) => e.id === edgeId);
  const next = edge && continuation(g, edge);
  if (!edge || !next) return null;
  const geometry = [...edge.geometry, ...next.geometry.slice(1)];
  const joined: GraphEdge = {
    ...edge,
    id: uid("e"),
    to: next.to,
    geometry,
    length_m: lengthM(geometry),
    provenance: { ...(edge.provenance ?? {}), ...userEdit(contributor) },
  };
  const edges = [...g.edges.filter((e) => e.id !== edge.id && e.id !== next.id), joined];
  const stillUsed = edges.some((e) => e.from === edge.to || e.to === edge.to);
  return { edgeId: joined.id, graph: { nodes: stillUsed ? g.nodes : g.nodes.filter((n) => n.id !== edge.to), edges } };
}

const key = (p: { lat: number; lng: number }) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;

/** Every distinct position in the graph, to ask an elevation source about. */
export function positions(g: Graph): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const n of g.nodes) seen.set(key(n), [n.lat, n.lng]);
  for (const e of g.edges) for (const v of e.geometry) seen.set(key(v), [v.lat, v.lng]);
  return [...seen.values()];
}

/** How much higher an edge's end must be than its start before it counts as pointing the wrong way. */
export const WRONG_WAY_M = 3;

/**
 * Refill every altitude from measured elevations, then point each slope
 * downhill and each lift uphill. Links are left alone: a traverse can
 * run either way. Returns how many edges were turned round.
 */
export function orientByElevation(g: Graph, elevations: Map<string, number>, contributor?: string): { graph: Graph; flipped: number } {
  const alt = <T extends { lat: number; lng: number; alt_m: number }>(p: T): T => {
    const m = elevations.get(key(p));
    return m === undefined ? p : { ...p, alt_m: m };
  };
  let flipped = 0;
  const edges = g.edges.map((e) => {
    const geometry = e.geometry.map(alt);
    const rise = geometry[geometry.length - 1].alt_m - geometry[0].alt_m;
    // A two-way line has no wrong way.
    const wrong = twinOf(g, e) ? false : e.kind === "slope" ? rise > WRONG_WAY_M : e.kind === "lift" ? rise < -WRONG_WAY_M : false;
    if (!wrong) return { ...e, geometry };
    flipped += 1;
    return { ...e, from: e.to, to: e.from, geometry: geometry.reverse(), provenance: { ...(e.provenance ?? {}), ...userEdit(contributor) } };
  });
  return { graph: { nodes: g.nodes.map(alt), edges }, flipped };
}

export const positionKey = key;

/** A new node on open ground. */
export function addNode(g: Graph, lat: number, lng: number, altM: number): { graph: Graph; nodeId: string } {
  const node: GraphNode = { id: uid("n"), lat, lng, alt_m: altM, kind: "waypoint" };
  return { graph: { ...g, nodes: [...g.nodes, node] }, nodeId: node.id };
}

export type NewLine = { kind: GraphEdge["kind"]; recordId: string | null };

/**
 * Draw an edge from one node to another through the bends given. A slope
 * or lift piece belongs to the record named; a link belongs to nothing.
 * Bends get a straight-line altitude until elevations are measured.
 */
export function addEdge(g: Graph, fromId: string, toId: string, via: { lat: number; lng: number }[], line: NewLine, contributor?: string): { graph: Graph; edgeId: string } | null {
  const from = g.nodes.find((n) => n.id === fromId);
  const to = g.nodes.find((n) => n.id === toId);
  if (!from || !to || from.id === to.id) return null;
  const geometry: Vertex[] = [
    { lat: from.lat, lng: from.lng, alt_m: from.alt_m },
    ...via.map((p, i) => ({ lat: p.lat, lng: p.lng, alt_m: Math.round(from.alt_m + ((to.alt_m - from.alt_m) * (i + 1)) / (via.length + 1)) })),
    { lat: to.lat, lng: to.lng, alt_m: to.alt_m },
  ];
  const edge: GraphEdge = {
    id: uid("e"),
    ...(line.kind === "slope" ? { slope_id: line.recordId } : line.kind === "lift" ? { lift_id: line.recordId } : { slope_id: null }),
    kind: line.kind,
    from: from.id,
    to: to.id,
    length_m: lengthM(geometry),
    geometry,
    provenance: userEdit(contributor),
  };
  return { graph: { ...g, edges: [...g.edges, edge] }, edgeId: edge.id };
}

/** Bring a catalog line (a slope or lift drawn before the graph existed) into the graph as one piece with a node at each end. */
export function importLine(g: Graph, coords: { lat: number; lng: number }[], line: NewLine, contributor?: string): { graph: Graph; edgeId: string } | null {
  if (coords.length < 2) return null;
  const a = addNode(g, coords[0].lat, coords[0].lng, 0);
  const b = addNode(a.graph, coords[coords.length - 1].lat, coords[coords.length - 1].lng, 0);
  return addEdge(b.graph, a.nodeId, b.nodeId, coords.slice(1, -1), line, contributor);
}

/** The pieces that belong to a slope or lift. */
export function piecesOf(g: Graph, kind: "slope" | "lift", recordId: string): GraphEdge[] {
  return g.edges.filter((e) => e.kind === kind && (kind === "slope" ? e.slope_id : e.lift_id) === recordId);
}

/**
 * Links that add nothing: a slope or lift already runs from the same
 * start to the same end, directly or through one junction, and is not
 * much longer than the link itself. Drawn beside the piste they look like
 * a second copy of it.
 */
export function redundantLinks(g: Graph): string[] {
  const out = new Map<string, GraphEdge[]>();
  for (const e of g.edges) if (e.kind !== "traverse") out.set(e.from, [...(out.get(e.from) ?? []), e]);
  const lengthOf = (e: GraphEdge) => e.length_m ?? lengthM(e.geometry);
  const ids: string[] = [];
  for (const link of g.edges) {
    if (link.kind !== "traverse") continue;
    const limit = lengthOf(link) * 1.5 + 50;
    const direct = (out.get(link.from) ?? []).some((e) => e.to === link.to && lengthOf(e) <= limit);
    const viaOne = (out.get(link.from) ?? []).some((e) => (out.get(e.to) ?? []).some((f) => f.to === link.to && lengthOf(e) + lengthOf(f) <= limit));
    if (direct || viaOne) ids.push(link.id);
  }
  return ids;
}

/** Remove edges, and any node nothing uses afterwards. */
export function removeEdges(g: Graph, ids: string[]): Graph {
  const gone = new Set(ids);
  const edges = g.edges.filter((e) => !gone.has(e.id));
  const used = new Set(edges.flatMap((e) => [e.from, e.to]));
  return { nodes: g.nodes.filter((n) => used.has(n.id)), edges };
}

/** Remove a node and every edge that starts or ends on it. */
export function removeNode(g: Graph, nodeId: string): Graph {
  return removeEdges({ nodes: g.nodes.filter((n) => n.id !== nodeId), edges: g.edges }, g.edges.filter((e) => e.from === nodeId || e.to === nodeId).map((e) => e.id));
}

/** Replace an edge's shape after its points were dragged; its ends stay on their nodes. */
export function reshapeEdge(g: Graph, edgeId: string, path: { lat: number; lng: number }[], contributor?: string): Graph {
  const edge = g.edges.find((e) => e.id === edgeId);
  const from = edge && g.nodes.find((n) => n.id === edge.from);
  const to = edge && g.nodes.find((n) => n.id === edge.to);
  if (!edge || !from || !to || path.length < 2) return g;
  const altNear = (p: { lat: number; lng: number }) => {
    let best = edge.geometry[0];
    for (const v of edge.geometry) if (distanceM(v, p) < distanceM(best, p)) best = v;
    return best.alt_m;
  };
  const geometry: Vertex[] = [
    { lat: from.lat, lng: from.lng, alt_m: from.alt_m },
    ...path.slice(1, -1).map((p) => ({ lat: p.lat, lng: p.lng, alt_m: altNear(p) })),
    { lat: to.lat, lng: to.lng, alt_m: to.alt_m },
  ];
  const next = { ...edge, geometry, length_m: lengthM(geometry), provenance: { ...(edge.provenance ?? {}), ...userEdit(contributor) } };
  return { ...g, edges: g.edges.map((e) => (e.id === edgeId ? next : e)) };
}

const recordOfEdge = (e: GraphEdge) => (e.kind === "slope" ? e.slope_id : e.kind === "lift" ? e.lift_id : null) ?? null;

/** The same line the other way: same kind, same slope or lift, ends swapped. A two-way line is such a pair. */
export function twinOf(g: Graph, edge: GraphEdge): GraphEdge | undefined {
  return g.edges.find((e) => e.id !== edge.id && e.kind === edge.kind && e.from === edge.to && e.to === edge.from && recordOfEdge(e) === recordOfEdge(edge));
}

/** Of a two-way pair, the one that is drawn and selected; the other follows it. An edge with no twin is its own. */
export function primaryOf(g: Graph, edge: GraphEdge): GraphEdge {
  const twin = twinOf(g, edge);
  return twin && twin.id < edge.id ? twin : edge;
}

/**
 * Edit one direction of a two-way line and rebuild the other from what
 * comes out, so the pair never drifts apart: reshaped, cut, renamed or
 * deleted, both directions get the same treatment. On a one-way line it
 * is just the edit.
 */
export function editPair(g: Graph, edgeId: string, op: (g: Graph) => Graph): Graph {
  const edge = g.edges.find((e) => e.id === edgeId);
  const twin = edge && twinOf(g, edge);
  if (!edge || !twin) return op(g);
  const without: Graph = { nodes: g.nodes, edges: g.edges.filter((e) => e.id !== twin.id) };
  const before = new Map(without.edges.map((e) => [e.id, e]));
  const after = op(without);
  // What the edit produced from this line: the line itself if it changed, and any new pieces.
  const fresh = after.edges.filter((e) => (e.id === edge.id && before.get(e.id) !== e) || !before.has(e.id));
  const unchanged = after.edges.find((e) => e.id === edge.id && before.get(e.id) === e);
  const mirrored = [...fresh, ...(unchanged ? [unchanged] : [])].map((e) => ({ ...e, id: uid("e"), from: e.to, to: e.from, geometry: [...e.geometry].reverse() }));
  return { nodes: after.nodes, edges: [...after.edges, ...mirrored] };
}

/**
 * Every line passing within reach of a point, nearest first. Lines that
 * lie on top of each other all come back, so the person can say which
 * one they meant. A two-way line counts once.
 */
export function edgesAt(g: Graph, lat: number, lng: number, withinM: number): GraphEdge[] {
  const hits: { edge: GraphEdge; distM: number }[] = [];
  for (const e of g.edges) {
    if (primaryOf(g, e).id !== e.id) continue;
    const near = nearestOnEdge(e, lat, lng);
    if (near && near.distM <= withinM) hits.push({ edge: e, distM: near.distM });
  }
  return hits.sort((a, b) => a.distM - b.distM).map((h) => h.edge);
}

/**
 * The bend of a line nearest a position, if one is within reach. A line
 * joined at one of its own bends keeps its shape; its ends are not bends,
 * they are nodes already.
 */
export function nearestBend(edge: GraphEdge, lat: number, lng: number, withinM: number): Vertex | null {
  let best: { v: Vertex; d: number } | null = null;
  for (const v of edge.geometry.slice(1, -1)) {
    const d = distanceM(v, { lat, lng });
    if (d <= withinM && (!best || d < best.d)) best = { v, d };
  }
  return best?.v ?? null;
}
