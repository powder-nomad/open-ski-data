"""
The writing half of build_slope_graph.py: human corrections, the
slope-graph document, and the list of things a person should look at.

Corrections live beside the graph in `slope-graph.corrections.json`:

  {"place_slug": "yongpyong", "corrections": [
    {"op": "reject", "id": "e-link-123-456"},             a link that isn't real
    {"op": "accept", "id": "e-link-123-456"},             a suggested link that is real
    {"op": "direction", "osm_way": 533261715, "starts_at": "n-5173762041"}
  ]}

They are re-applied on every build, so a decision is made once. A graph
that has been edited by hand in the editor (any `user-edit` edge) is not
rebuilt at all unless asked: see `human_owned`.
"""

from __future__ import annotations

import collections
import json
from pathlib import Path

OSM_DIFFICULTY = {
    "novice": "beginner", "easy": "beginner", "intermediate": "intermediate",
    "advanced": "advanced", "expert": "expert", "extreme": "expert", "freeride": "expert",
}
# slopes.json spells some levels differently from the graph schema's enum.
CATALOG_DIFFICULTY = {
    "beginner": "beginner", "beginner_intermediate": "be_in", "be_in": "be_in",
    "intermediate": "intermediate", "intermediate_advanced": "in_ad", "in_ad": "in_ad",
    "advanced": "advanced", "expert": "expert", "pro": "pro",
    "terrain_park": "park", "park": "park",
}

SUGGEST_LIFT_M = 120
SUGGEST_SLOPE_M = 60
# An observed link seen fewer times than this is worth a human look.
WEAK_LINK = 3

CORRECTIONS_FILE = "slope-graph.corrections.json"


def load_corrections(place_dir: Path) -> list[dict]:
    path = place_dir / CORRECTIONS_FILE
    return json.loads(path.read_text()).get("corrections", []) if path.exists() else []


def forced_directions(corrections: list[dict]) -> dict[int, int]:
    """OSM way id → the OSM node the way starts at, for every direction a person has set."""
    return {c["osm_way"]: int(c["starts_at"][2:]) for c in corrections if c.get("op") == "direction"}


def label(e) -> str:
    t = e.way["tags"]
    name = t.get("name:ko") or t.get("name") or t.get("name:en") or f"unnamed {e.way['id']}"
    return f"{name} (lift)" if e.kind == "lift" else name


def emit(cfg: dict, g: dict, corrections: list[dict]) -> tuple[dict, str, list[dict]]:
    pos, alt, plane = g["pos"], g["alt"], g["plane"]
    notes = list(g["notes"])
    rejected = {c["id"] for c in corrections if c.get("op") == "reject"}
    accepted = {c["id"] for c in corrections if c.get("op") == "accept"}
    directed = forced_directions(corrections)

    def vertex(n):
        return {"lat": round(pos[n][0], 7), "lng": round(pos[n][1], 7), "alt_m": round(alt[n], 1)}

    out_edges = []
    starts = collections.defaultdict(list)   # node -> edges leaving it
    ends = collections.defaultdict(list)
    lift_ends = {}
    unsure = {}

    def add(e, nodes: list[int], suffix: str = ""):
        row = {"id": e.id + suffix}
        if e.kind == "slope":
            row["slope_id"] = e.rec["id"] if e.rec else None
        elif e.rec:
            row["lift_id"] = e.rec["id"]
        row["kind"] = e.kind
        if e.kind == "slope":
            diff = CATALOG_DIFFICULTY.get((e.rec or {}).get("difficulty") or "") or OSM_DIFFICULTY.get(e.way["tags"].get("piste:difficulty", ""))
            if diff:
                row["difficulty"] = diff
        row["from"], row["to"] = f"n-{nodes[0]}", f"n-{nodes[-1]}"
        row["length_m"] = round(plane.length([pos[n] for n in nodes]), 1)
        row["geometry"] = [vertex(n) for n in nodes]
        row["provenance"] = {"source": "osm", "osm_way_id": e.way["id"]}
        if g["have_tracks"]:
            row["provenance"]["observed_count"] = e.rides
        out_edges.append(row)
        starts[nodes[0]].append(row)
        ends[nodes[-1]].append(row)
        if e.kind == "lift":
            lift_ends[nodes[0]] = "lift_bottom"
            lift_ends[nodes[-1]] = "lift_top"

    for e in g["edges"]:
        add(e, e.nodes)
        if e.way["id"] in g["two_way"]:
            add(e, e.nodes[::-1], "-rev")
        elif e.unsure and e.kind == "slope" and e.way["id"] not in directed:
            unsure.setdefault(e.way["id"], e)

    graph_nodes = {n for e in g["edges"] for n in (e.nodes[0], e.nodes[-1])}
    link_id = lambda a, b: f"e-link-{a}-{b}"  # noqa: E731

    links = {
        (a, b): {"source": "observed", "observed_count": count}
        for (a, b), count in g["links"].items() if link_id(a, b) not in rejected
    }

    # Suggestions: ends that are close and nobody has ridden between yet.
    # A lift's top to the slopes that start beside it, and a slope's end to
    # the lift bases beside it. Never mid-slope.
    joined = {(int(r["from"][2:]), int(r["to"][2:])) for r in out_edges} | set(links)

    def suggest(a: int, b: int):
        if (a, b) in joined or link_id(a, b) in rejected:
            return
        joined.add((a, b))
        links[(a, b)] = {"source": "suggested"}

    slope_starts = [n for n, rows in starts.items() if any(r["kind"] == "slope" for r in rows)]
    slope_ends = [n for n, rows in ends.items() if any(r["kind"] == "slope" for r in rows)]
    for n, kind in lift_ends.items():
        if kind == "lift_top":
            for s in slope_starts:
                if s != n and plane.dist(pos[n], pos[s]) <= SUGGEST_LIFT_M:
                    suggest(n, s)
        else:
            for s in slope_ends:
                if s != n and plane.dist(pos[n], pos[s]) <= SUGGEST_LIFT_M:
                    suggest(s, n)
    for s in slope_ends:
        if starts[s]:
            continue  # the slope already goes on from here
        for t in slope_starts:
            if t != s and plane.dist(pos[s], pos[t]) <= SUGGEST_SLOPE_M and alt[t] <= alt[s] + 5:
                suggest(s, t)

    # A person's accept turns a suggestion into a fact, or adds a link the
    # generator never proposed.
    for lid in sorted(accepted):
        try:
            a, b = (int(x) for x in lid.removeprefix("e-link-").split("-"))
        except ValueError:
            notes.append(f"correction skipped: {lid} is not a link id")
            continue
        if a not in graph_nodes or b not in graph_nodes:
            notes.append(f"correction skipped: {lid} names nodes the graph no longer has")
        elif links.get((a, b), {}).get("source") != "observed":
            links[(a, b)] = {"source": "user-edit"}

    for (a, b), provenance in sorted(links.items()):
        out_edges.append({
            "id": link_id(a, b), "slope_id": None, "kind": "traverse",
            "from": f"n-{a}", "to": f"n-{b}",
            "length_m": round(plane.dist(pos[a], pos[b]), 1),
            "geometry": [vertex(a), vertex(b)],
            "provenance": provenance,
        })

    node_ids = sorted({int(r[k][2:]) for r in out_edges for k in ("from", "to")})
    out_deg = collections.Counter(r["from"] for r in out_edges if r["kind"] != "traverse")
    in_deg = collections.Counter(r["to"] for r in out_edges if r["kind"] != "traverse")
    nodes = []
    for n in node_ids:
        nid = f"n-{n}"
        kind = lift_ends.get(n) or ("fork" if out_deg[nid] > 1 else "merge" if in_deg[nid] > 1 else "waypoint")
        nodes.append({"id": nid, **vertex(n), "kind": kind})

    doc = {
        "$schema": "../../../../schemas/slope-graph.schema.json",
        "place_slug": cfg["slug"],
        "version": 2,
        "nodes": nodes,
        "edges": out_edges,
    }

    # What a person should look at, numbered for the review picture.
    items = []

    def item(kind: str, target: str, text: str, at: int):
        items.append({"n": len(items) + 1, "type": kind, "id": target, "label": text, "at": [pos[at][0], pos[at][1]]})

    def names(n: int, rows) -> str:
        return "+".join(sorted({r.get("slope_id") or r.get("lift_id") or "unnamed" for r in rows[n]})) or "?"

    for r in out_edges:
        if r["kind"] != "traverse":
            continue
        a, b = int(r["from"][2:]), int(r["to"][2:])
        source = r["provenance"]["source"]
        if source == "suggested":
            item("suggested-link", r["id"], f"{names(a, ends)} → {names(b, starts)}, {r['length_m']:.0f} m, never ridden", a)
        elif source == "observed" and r["provenance"]["observed_count"] < WEAK_LINK:
            item("weak-link", r["id"], f"{names(a, ends)} → {names(b, starts)}, {r['length_m']:.0f} m, ridden {r['provenance']['observed_count']}×", a)
    for way_id, e in sorted(unsure.items()):
        item("direction", str(way_id), f"{label(e)}: direction is a guess (flat, too few rides)", e.nodes[len(e.nodes) // 2])

    by_kind = collections.Counter(r["kind"] for r in out_edges)
    by_source = collections.Counter(r["provenance"]["source"] for r in out_edges if r["kind"] == "traverse")
    unridden = [r for r in out_edges if r["provenance"]["source"] == "osm" and r["provenance"].get("observed_count") == 0]
    no_id = sorted({str(e.way["id"]) + " " + label(e) for e in g["edges"] if not e.rec})
    lines = [
        f"# {cfg['slug']} slope graph", "",
        f"- {by_kind['slope']} slope edges, {by_kind['lift']} lift edges, {len(nodes)} nodes",
        f"- {by_source['observed']} observed links, {by_source['user-edit']} confirmed by a person, "
        f"{by_source['suggested']} suggested",
        f"- track days used: {g['days']}; corrections applied: {len(corrections)}",
        "- routable today: {} of {} slope and lift edges are in one loop a rider can be routed around".format(*routable(doc)),
        f"- {len(items)} things for a person to look at (scripts/review/{cfg['slug']}-graph-items.json)",
        "",
    ]
    if g["have_tracks"]:
        lines += ["## Never ridden in the tracks", ""] + [f"- {r['id']} ({r.get('slope_id') or r.get('lift_id') or 'no catalog id'})" for r in unridden] + [""]
    lines += ["## OSM ways with no catalog record", ""] + [f"- {x}" for x in no_id] + [""]
    lines += ["## Transitions seen but not written", "",
              "Seen once, too few sightings to split a slope for, or the two ends are too far",
              "apart to join with a straight link: a line the map is missing.", ""]
    lines += [f"- {c}× {label(a)} → {label(b)} ({gap:.0f} m apart)" for c, a, b, gap in sorted(g["dropped"], key=lambda x: -x[0])] + [""]
    lines += ["## To look at", ""] + [f"{i['n']}. [{i['type']}] {i['label']} — `{i['id']}`" for i in items] + [""]
    lines += ["## Notes", ""] + [f"- {n}" for n in notes] + [""]
    return doc, "\n".join(lines), items


def connections(doc: dict):
    """Every directed hop routing may take: edges that aren't merely suggested, and both ways through a gondola."""
    for e in doc["edges"]:
        if e["provenance"]["source"] == "suggested":
            continue
        yield e["from"], e["to"]
        if e["kind"] == "lift" and "gondola" in (e.get("lift_id") or ""):
            yield e["to"], e["from"]


def routable(doc: dict) -> tuple[int, int]:
    """(slope and lift edges inside the largest loop, all slope and lift edges).

    The loop is the largest set of nodes that can all reach each other
    following edge directions: what a rider can actually be routed around today.
    """
    out = collections.defaultdict(set)
    back = collections.defaultdict(set)
    for a, b in connections(doc):
        out[a].add(b)
        back[b].add(a)

    def reach(start, adj):
        seen, stack = {start}, [start]
        while stack:
            for nxt in adj[stack.pop()]:
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    best: set = set()
    left = {n["id"] for n in doc["nodes"]}
    while left:
        n = left.pop()
        loop = reach(n, out) & reach(n, back)
        left -= loop
        if len(loop) > len(best):
            best = loop
    real = [e for e in doc["edges"] if e["kind"] != "traverse"]
    return sum(1 for e in real if e["from"] in best and e["to"] in best), len(real)


def human_owned(path: Path) -> bool:
    """True when the published graph carries a person's edits, which a rebuild would throw away."""
    if not path.exists():
        return False
    doc = json.loads(path.read_text())
    return any((e.get("provenance") or {}).get("source") == "user-edit" for e in doc.get("edges", []))
