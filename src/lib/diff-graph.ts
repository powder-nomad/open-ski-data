/**
 * Pure diff functions over slope-graph.json.
 *
 * Client-side: no backend, no network. Called once per resort after
 * both the base and head blobs are fetched from raw.githubusercontent.com.
 */

import type { GraphNode, GraphEdge, SlopeGraphRecord } from "./resort-loader";

export type DiffKind = "added" | "removed" | "modified";

export type NodeDiff = {
  kind: DiffKind;
  id: string;
  before?: GraphNode;
  after?: GraphNode;
};

export type EdgeDiff = {
  kind: DiffKind;
  id: string;
  before?: GraphEdge;
  after?: GraphEdge;
  /** True when the polyline geometry changed, not just metadata. */
  geometryChanged: boolean;
};

export type GraphDiff = {
  nodes: NodeDiff[];
  edges: EdgeDiff[];
  /** Any added/removed/modified edge with different geometry. */
  hasGeometryChanges: boolean;
};

function coordsEqual(
  a: { lat: number; lng: number; alt_m: number }[],
  b: { lat: number; lng: number; alt_m: number }[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (p, i) => p.lat === b[i].lat && p.lng === b[i].lng && p.alt_m === b[i].alt_m,
  );
}

export function diffGraph(
  base: SlopeGraphRecord | null,
  head: SlopeGraphRecord | null,
): GraphDiff {
  const baseNodes = new Map<string, GraphNode>(
    (base?.nodes ?? []).map((n) => [n.id, n]),
  );
  const headNodes = new Map<string, GraphNode>(
    (head?.nodes ?? []).map((n) => [n.id, n]),
  );
  const baseEdges = new Map<string, GraphEdge>(
    (base?.edges ?? []).map((e) => [e.id, e]),
  );
  const headEdges = new Map<string, GraphEdge>(
    (head?.edges ?? []).map((e) => [e.id, e]),
  );

  const nodes: NodeDiff[] = [];
  for (const [id, n] of baseNodes) {
    if (!headNodes.has(id)) {
      nodes.push({ kind: "removed", id, before: n });
    } else {
      const h = headNodes.get(id)!;
      if (JSON.stringify(n) !== JSON.stringify(h)) {
        nodes.push({ kind: "modified", id, before: n, after: h });
      }
    }
  }
  for (const [id, n] of headNodes) {
    if (!baseNodes.has(id)) nodes.push({ kind: "added", id, after: n });
  }

  const edges: EdgeDiff[] = [];
  for (const [id, e] of baseEdges) {
    if (!headEdges.has(id)) {
      edges.push({ kind: "removed", id, before: e, geometryChanged: false });
    } else {
      const h = headEdges.get(id)!;
      const geomSame = coordsEqual(e.geometry, h.geometry);
      const metaSame =
        e.from === h.from &&
        e.to === h.to &&
        e.kind === h.kind &&
        geomSame;
      if (!metaSame) {
        edges.push({
          kind: "modified",
          id,
          before: e,
          after: h,
          geometryChanged: !geomSame,
        });
      }
    }
  }
  for (const [id, e] of headEdges) {
    if (!baseEdges.has(id)) {
      edges.push({ kind: "added", id, after: e, geometryChanged: false });
    }
  }

  // "Geometry changed" means a coordinate path was actually modified,
  // NOT just that edges were added or removed (topology-only). PR #2
  // removes 6 dup edges but touches no coordinate data, so the banner
  // should read "algorithmic only" — no visual path was redrawn.
  const hasGeometryChanges = edges.some(
    (e) => e.kind === "modified" && e.geometryChanged,
  );

  return { nodes, edges, hasGeometryChanges };
}
