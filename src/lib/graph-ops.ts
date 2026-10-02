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
  const upper = [...edge.geometry.slice(0, at.segment), at.point];
  const lower = [at.point, ...edge.geometry.slice(at.segment)];
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
    const wrong = e.kind === "slope" ? rise > WRONG_WAY_M : e.kind === "lift" ? rise < -WRONG_WAY_M : false;
    if (!wrong) return { ...e, geometry };
    flipped += 1;
    return { ...e, from: e.to, to: e.from, geometry: geometry.reverse(), provenance: { ...(e.provenance ?? {}), ...userEdit(contributor) } };
  });
  return { graph: { nodes: g.nodes.map(alt), edges }, flipped };
}

export const positionKey = key;
