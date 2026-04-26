#!/usr/bin/env python3
"""
Migrate a resort's slopes.json into a slope-graph.json.

Usage:
    python3 scripts/migrate-to-slope-graph.py registry/kr/gangwon/yongpyong

Each existing slope's polyline becomes one edge between two nodes
(first + last vertex). Nodes within 10m of each other coalesce to a
single shared node — that's where diverges and merges fall out
naturally without any hand authoring. Elevations are fetched from
Open-Meteo's free Elevation API in batches of 100.

Output:
    <resort_dir>/slope-graph.json (new)
    <resort_dir>/slopes-migrated.json (slopes annotated with edge_ids;
    not promoted to slopes.json — caller reviews + git mv)

Design notes:
- Coalesce radius: 10m. Tighter misses snap-to-fork at typical 5-8m
  GPS jitter; looser merges genuinely separate runs.
- Elevation: Open-Meteo (free, no key, ~50ms/100pts) for endpoint
  nodes. Vertex-by-vertex elevation along edges is linearly
  interpolated between endpoints — cheap and accurate enough for
  slope rendering. Sub-vertex precision is a Google-Elevation-API
  follow-up if/when Paul wants it.
- Endpoint tolerance: edge.geometry[0] / [-1] must be within 5m of
  the from/to node per slope-graph schema. Coalescing already snaps
  within 10m, but we explicitly overwrite the first/last vertex with
  the chosen node's exact lat/lng/alt_m so the schema validator is
  happy.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import requests

COALESCE_M = 10.0
ELEVATION_API = "https://api.open-meteo.com/v1/elevation"
BATCH_SIZE = 100


def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    """Great-circle distance in metres. Argument tuples are (lat, lon)."""
    r = 6_371_000.0
    lat1, lon1 = map(math.radians, a)
    lat2, lon2 = map(math.radians, b)
    dlat = lat2 - lat1
    dlon = lon2 - lon1
    h = (
        math.sin(dlat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(h))


def coalesce_nodes(
    raw_points: list[tuple[float, float]],
) -> list[tuple[float, float]]:
    """
    Greedy-merge: walk points; each point either lands within
    COALESCE_M of an existing cluster centre (assigned there) or
    starts a new cluster. Returns one representative (lat, lon) per
    cluster — the centroid of its members.
    """
    clusters: list[list[tuple[float, float]]] = []
    for p in raw_points:
        attached = False
        for c in clusters:
            # Compare against cluster's running centroid.
            n = len(c)
            cx = sum(q[0] for q in c) / n
            cy = sum(q[1] for q in c) / n
            if haversine_m((cx, cy), p) <= COALESCE_M:
                c.append(p)
                attached = True
                break
        if not attached:
            clusters.append([p])
    return [
        (sum(q[0] for q in c) / len(c), sum(q[1] for q in c) / len(c))
        for c in clusters
    ]


def assign_to_cluster(
    p: tuple[float, float],
    cluster_centres: list[tuple[float, float]],
) -> int:
    """Index of the closest cluster — used to map endpoints back to nodes."""
    best_i = 0
    best_d = haversine_m(p, cluster_centres[0])
    for i, c in enumerate(cluster_centres):
        d = haversine_m(p, c)
        if d < best_d:
            best_d = d
            best_i = i
    return best_i


def fetch_elevations(points: list[tuple[float, float]]) -> list[float]:
    """Batch-fetch elevation from Open-Meteo. Returns metres above WGS84."""
    out: list[float] = []
    for batch_start in range(0, len(points), BATCH_SIZE):
        batch = points[batch_start : batch_start + BATCH_SIZE]
        lats = ",".join(f"{p[0]:.6f}" for p in batch)
        lons = ",".join(f"{p[1]:.6f}" for p in batch)
        resp = requests.get(
            ELEVATION_API,
            params={"latitude": lats, "longitude": lons},
            timeout=30,
        )
        resp.raise_for_status()
        body = resp.json()
        out.extend(float(e) for e in body.get("elevation", []))
    return out


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: migrate-to-slope-graph.py <resort_dir>", file=sys.stderr)
        return 2
    resort_dir = Path(sys.argv[1])
    slopes_path = resort_dir / "slopes.json"
    if not slopes_path.exists():
        print(f"no slopes.json at {slopes_path}", file=sys.stderr)
        return 2

    with slopes_path.open("r", encoding="utf-8") as f:
        slopes_doc = json.load(f)
    slopes = slopes_doc.get("slopes", [])
    cc = slopes_doc.get("country_code")
    rs = slopes_doc.get("region_slug")
    ps = slopes_doc.get("place_slug")

    print(f"  loaded {len(slopes)} slopes")

    # Step 1 — collect endpoint candidates.
    endpoints: list[tuple[float, float]] = []
    slope_endpoints: list[tuple[tuple[float, float], tuple[float, float]] | None] = []
    for s in slopes:
        coords = s.get("coordinates") or []
        if len(coords) < 2:
            slope_endpoints.append(None)
            continue
        first = (float(coords[0]["lat"]), float(coords[0]["lon"]))
        last = (float(coords[-1]["lat"]), float(coords[-1]["lon"]))
        endpoints.append(first)
        endpoints.append(last)
        slope_endpoints.append((first, last))

    # Step 2 — coalesce.
    cluster_centres = coalesce_nodes(endpoints)
    print(f"  {len(endpoints)} endpoints → {len(cluster_centres)} unique nodes after {COALESCE_M:.0f}m coalesce")

    # Step 3 — fetch elevations once per node.
    print(f"  fetching elevations for {len(cluster_centres)} nodes…")
    elevations = fetch_elevations(cluster_centres)

    # Step 4 — build the node table.
    nodes = []
    for i, (lat, lon) in enumerate(cluster_centres):
        nodes.append(
            {
                "id": f"n-{i:04d}",
                "lat": round(lat, 6),
                "lng": round(lon, 6),
                "alt_m": round(elevations[i], 1),
                "kind": "waypoint",
            }
        )

    # Step 5 — emit edges + annotate slopes with edge_ids.
    edges = []
    slopes_migrated = []
    for s, ep in zip(slopes, slope_endpoints):
        if ep is None:
            slopes_migrated.append({**s, "edge_ids": []})
            continue
        first, last = ep
        from_idx = assign_to_cluster(first, cluster_centres)
        to_idx = assign_to_cluster(last, cluster_centres)
        from_node = nodes[from_idx]
        to_node = nodes[to_idx]

        # Build geometry: original vertices, but force first/last to
        # match the assigned node exactly so the schema's 5m endpoint
        # tolerance always passes. Interior vertex elevations are
        # linearly interpolated along path-length.
        coords = s["coordinates"]
        # Cumulative path length for elevation interpolation.
        cum = [0.0]
        for j in range(1, len(coords)):
            d = haversine_m(
                (coords[j - 1]["lat"], coords[j - 1]["lon"]),
                (coords[j]["lat"], coords[j]["lon"]),
            )
            cum.append(cum[-1] + d)
        total = cum[-1] if cum[-1] > 0 else 1.0
        z_from = from_node["alt_m"]
        z_to = to_node["alt_m"]

        geometry = []
        for j, c in enumerate(coords):
            if j == 0:
                geometry.append(
                    {
                        "lat": from_node["lat"],
                        "lng": from_node["lng"],
                        "alt_m": from_node["alt_m"],
                    }
                )
                continue
            if j == len(coords) - 1:
                geometry.append(
                    {
                        "lat": to_node["lat"],
                        "lng": to_node["lng"],
                        "alt_m": to_node["alt_m"],
                    }
                )
                continue
            t = cum[j] / total
            interp_alt = z_from + (z_to - z_from) * t
            geometry.append(
                {
                    "lat": round(c["lat"], 6),
                    "lng": round(c["lon"], 6),
                    "alt_m": round(interp_alt, 1),
                }
            )

        # Skip slopes whose endpoints coalesced into the same node —
        # the original polyline was shorter than COALESCE_M total.
        # Those are usually OSM noise; preserve the slope row but
        # leave edge_ids empty so the user can re-draw geometry later.
        if from_node["id"] == to_node["id"]:
            slopes_migrated.append({**s, "edge_ids": []})
            continue

        edge_id = f"e-{len(edges):04d}"
        edges.append(
            {
                "id": edge_id,
                "from": from_node["id"],
                "to": to_node["id"],
                "kind": "slope",
                "geometry": geometry,
            }
        )
        slopes_migrated.append({**s, "edge_ids": [edge_id]})

    graph_doc = {
        "$schema": "../../../../schemas/slope-graph.schema.json",
        "place_slug": ps,
        "version": 1,
        "nodes": nodes,
        "edges": edges,
    }
    out_graph = resort_dir / "slope-graph.json"
    with out_graph.open("w", encoding="utf-8") as f:
        json.dump(graph_doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"  wrote {out_graph} ({len(nodes)} nodes, {len(edges)} edges)")

    migrated_doc = {
        **slopes_doc,
        "slopes": slopes_migrated,
    }
    out_migrated = resort_dir / "slopes-migrated.json"
    with out_migrated.open("w", encoding="utf-8") as f:
        json.dump(migrated_doc, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(f"  wrote {out_migrated} (review before promoting to slopes.json)")
    print(f"  resort: {cc}/{rs}/{ps}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
