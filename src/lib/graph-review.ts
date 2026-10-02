/**
 * Reviewing a slope graph by hand: which edges deserve a look, what to
 * call them, and the edits a reviewer makes (flip, two-way, link ends).
 * Pure functions; the editor owns the state.
 */

import type { EdgeProvenance, GraphEdge, GraphNode } from "./resort-loader";

/** An observed link seen fewer times than this is worth a look. */
export const WEAK_LINK = 3;
/** A slope edge falling less than this, with few rides, may point the wrong way. */
export const SURE_DROP_M = 15;

export type ReviewReason = "suggested" | "weak" | "direction";
export type ReviewItem = { edgeId: string; reason: ReviewReason };
/** Two nodes close enough that they are probably one place drawn twice. */
export type NearPair = { a: string; b: string; distM: number };
/** Nodes nearer than this, and not already joined by an edge, are offered for welding. */
export const NEAR_M = 15;

export function nearPairs(nodes: GraphNode[], edges: GraphEdge[]): NearPair[] {
  const joined = new Set(edges.flatMap((e) => [`${e.from}>${e.to}`, `${e.to}>${e.from}`]));
  const out: NearPair[] = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      if (Math.abs(a.lat - b.lat) > 0.0003) continue; // ~33 m: cheap reject before the real distance
      const d = metres(a, b);
      if (d <= NEAR_M && !joined.has(`${a.id}>${b.id}`)) out.push({ a: a.id, b: b.id, distM: Math.round(d) });
    }
  }
  return out.sort((x, y) => x.distM - y.distM);
}

export function userEdit(contributor?: string): EdgeProvenance {
  return {
    source: "user-edit",
    ...(contributor ? { contributor } : {}),
    last_verified: new Date().toISOString().slice(0, 10),
  };
}

/** The same edge ridden the other way. A person decided, so it becomes a user edit. */
export function flipped(edge: GraphEdge, contributor?: string): Pick<GraphEdge, "from" | "to" | "geometry" | "provenance"> {
  return {
    from: edge.to,
    to: edge.from,
    geometry: [...edge.geometry].reverse(),
    provenance: { ...(edge.provenance ?? {}), ...userEdit(contributor) },
  };
}

/** Edges a person hasn't decided on yet and probably should, most doubtful first. */
export function reviewItems(edges: GraphEdge[], nodes: Map<string, GraphNode>): ReviewItem[] {
  const out: ReviewItem[] = [];
  for (const e of edges) {
    const source = e.provenance?.source;
    if (!source || source === "user-edit") continue;
    if (source === "suggested") {
      out.push({ edgeId: e.id, reason: "suggested" });
    } else if (e.kind === "traverse" && source === "observed" && (e.provenance?.observed_count ?? 0) < WEAK_LINK) {
      out.push({ edgeId: e.id, reason: "weak" });
    } else if (e.kind === "slope" && (e.provenance?.observed_count ?? 0) < WEAK_LINK) {
      const a = nodes.get(e.from);
      const b = nodes.get(e.to);
      if (a && b && Math.abs(a.alt_m - b.alt_m) < SURE_DROP_M) out.push({ edgeId: e.id, reason: "direction" });
    }
  }
  const rank: Record<ReviewReason, number> = { direction: 0, suggested: 1, weak: 2 };
  return out.sort((x, y) => rank[x.reason] - rank[y.reason]);
}

/** What an edge is called: its slope or lift name; a link is named by what it joins. */
export function edgeLabel(
  edge: GraphEdge,
  names: Map<string, string>,
  all: GraphEdge[],
): string {
  const own = edge.slope_id ?? edge.lift_id;
  if (own) return names.get(own) ?? own;
  if (edge.kind !== "traverse") return edge.id;
  const named = (e: GraphEdge) => {
    const id = e.slope_id ?? e.lift_id;
    return e.kind !== "traverse" && id ? names.get(id) ?? id : null;
  };
  const unique = (xs: (string | null)[]) => [...new Set(xs.filter((x): x is string => !!x))].join(" · ") || "?";
  const before = unique(all.filter((e) => e.to === edge.from).map(named));
  const after = unique(all.filter((e) => e.from === edge.to).map(named));
  return `${before} → ${after}`;
}

function metres(a: GraphNode, b: GraphNode): number {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r;
  const dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function link(from: GraphNode, to: GraphNode, contributor?: string): GraphEdge {
  return {
    id: `e-u-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    slope_id: null,
    kind: "traverse",
    from: from.id,
    to: to.id,
    length_m: Math.round(metres(from, to) * 10) / 10,
    geometry: [
      { lat: from.lat, lng: from.lng, alt_m: from.alt_m },
      { lat: to.lat, lng: to.lng, alt_m: to.alt_m },
    ],
    provenance: userEdit(contributor),
  };
}

/** The reverse of a link, for ground you can cross both ways. Null when it already exists. */
export function reverseLink(edge: GraphEdge, nodes: Map<string, GraphNode>, existing: GraphEdge[], contributor?: string): GraphEdge | null {
  const from = nodes.get(edge.to);
  const to = nodes.get(edge.from);
  if (!from || !to || existing.some((e) => e.from === from.id && e.to === to.id)) return null;
  return link(from, to, contributor);
}

/**
 * Join every pair of the given ends in both directions: a flat area
 * (a summit plateau, a base) where each end reaches every other. Each
 * link keeps its real length, so a long walk still costs a long walk.
 * Pairs already joined in a direction are left alone.
 */
export function linkAll(ends: GraphNode[], existing: GraphEdge[], contributor?: string): GraphEdge[] {
  const have = new Set(existing.map((e) => `${e.from}>${e.to}`));
  const out: GraphEdge[] = [];
  for (const a of ends) {
    for (const b of ends) {
      if (a.id === b.id || have.has(`${a.id}>${b.id}`)) continue;
      have.add(`${a.id}>${b.id}`);
      out.push(link(a, b, contributor));
    }
  }
  return out;
}

/** How an edge is drawn: by where it came from, so doubt is visible at a glance. */
export function edgeColour(edge: GraphEdge): { colour: string; dashed: boolean } {
  switch (edge.provenance?.source) {
    case "suggested": return { colour: "#fbbf24", dashed: true };
    case "observed": return { colour: "#4ade80", dashed: false };
    case "user-edit": return { colour: "#38bdf8", dashed: false };
    default: return { colour: edge.kind === "lift" ? "#f8fafc" : "#94a3b8", dashed: false };
  }
}
