#!/usr/bin/env python3
"""
Build a resort's slope-graph.json from OpenStreetMap, connected by what
riders actually did.

Nothing here joins two lines because they are near each other. A
connection exists only when:

  osm        the OSM mappers drew the two ways through a shared node, or
  observed   recorded tracks went from one to the other (the count is kept), or
  suggested  the two ends are close and nobody has ridden it yet — written
             so an editor can confirm or delete it, and consumers that
             route should leave it out.

Pipeline:
  1. Fetch    — Overpass by the resort's bbox (cached), pistes + lifts.
  2. Keep     — drop areas, stations, and ways that belong to a
                neighbouring resort in the registry.
  3. Split    — slopes break at every node another kept way shares, so a
                slope that forks and rejoins becomes several edges. Lifts
                are never split: you get on and off at the ends.
  4. Elevate  — Open-Meteo elevation for every vertex (cached).
  5. Orient   — slopes run downhill and lifts uphill; when tracks rode an
                edge three or more times, their direction wins over the DEM.
  6. Observe  — match tracks to edges with their own up/down split (not
                the recording app's labels), count rides and edge-to-edge
                transitions, and turn transitions between edges that
                don't touch into `traverse` edges.
  7. Zone     — ends that riders move between on the flat (a summit
                plateau, a base area) become one zone: every end in it
                reaches every other (slope_graph_emit.py).
  8. Correct  — re-apply the resort's slope-graph.corrections.json, so a
                human's accept / reject / direction / zone outlives rebuilds.
  9. Write    — registry/<cc>/<region>/<slug>/slope-graph.json (version 2),
                scripts/review/<slug>-graph.md and the numbered review items
                that render_slope_graph.py draws.

Tracks are optional and never leave your machine: only ride counts are
written. Supported: Slopes exports (`.slopes`, a zip with GPS.csv) and GPX.

Usage:
  python scripts/build_slope_graph.py yongpyong --tracks ~/tracks
  python scripts/build_slope_graph.py --dry-run high1
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import glob
import json
import math
import os
import re
import statistics
import sys
import time
import zipfile
from pathlib import Path

import requests
import yaml

import slope_graph_emit

REPO_ROOT = Path(__file__).resolve().parent.parent
RESORT_DIR = Path(__file__).resolve().parent / "resorts"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
REVIEW_DIR = Path(__file__).resolve().parent / "review"

OVERPASS_URLS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
USER_AGENT = "open-ski-data build_slope_graph (https://github.com/powder-nomad/open-ski-data)"

# aerialway values that carry riders. `yes`, `station`, `pylon`, `goods`
# and the like are not lifts you can route over.
LIFT_TYPES = {
    "gondola", "cable_car", "chair_lift", "mixed_lift", "drag_lift",
    "t-bar", "j-bar", "platter", "rope_tow", "magic_carpet",
}
# Track matching. A day is cut into climbs (lifts) and descents (slopes) on
# altitude smoothed over +-SMOOTH_S seconds; a leg turns after LEG_TURN_M
# the other way.
SMOOTH_S = 20
LEG_TURN_M = 25
LIFT_REACH_M = 40
SLOPE_REACH_M = 60
RIDE_MIN_POINTS = 4
# A transition is believed only if the rider was matched again within this
# distance of where they were last matched; further means they rode
# something the map doesn't have in between.
TRANSITION_GAP_M = 250
TRACK_MARGIN_M = 300
# Half the side of the box searched around a resort that has no yaml.
DEFAULT_BOX_M = 5000
# Leaving a slope this close to its end counts as leaving at the end.
END_SLACK_M = 60
# How often a transition must be seen to be written at all, and before it
# may split a slope mid-way.
LINK_MIN = 2
SPLIT_MIN_SLOPE_TO_SLOPE = 3
SPLIT_MIN_WITH_LIFT = 2
DIRECTION_MIN_RIDES = 3
# Below this fall, and without enough rides to say, a slope's direction is a guess.
SURE_DROP_M = 15
NEIGHBOUR_MATCH_M = 40
CATALOG_MATCH_M = 30

ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6"}


# ── geometry ──────────────────────────────────────────────────────────

class Plane:
    """Local metres around a latitude: good to a few cm at resort scale."""

    def __init__(self, lat0: float):
        self.kx = 111_320 * math.cos(math.radians(lat0))
        self.ky = 111_320

    def xy(self, p):
        return (p[1] * self.kx, p[0] * self.ky)

    def dist(self, a, b) -> float:
        ax, ay = self.xy(a)
        bx, by = self.xy(b)
        return math.hypot(ax - bx, ay - by)

    def to_segment(self, p, a, b) -> float:
        px, py = self.xy(p)
        ax, ay = self.xy(a)
        bx, by = self.xy(b)
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
        return math.hypot(px - ax - t * dx, py - ay - t * dy)

    def to_line(self, p, line) -> float:
        return min(self.to_segment(p, a, b) for a, b in zip(line, line[1:]))

    def mean_to_line(self, pts, line) -> float:
        return sum(self.to_line(p, line) for p in pts) / len(pts)

    def length(self, line) -> float:
        return sum(self.dist(a, b) for a, b in zip(line, line[1:]))


# ── inputs ────────────────────────────────────────────────────────────

def load_config(slug: str) -> dict:
    """The resort's yaml when it has one; otherwise a box around its place.json coordinates."""
    path = RESORT_DIR / f"{slug}.yaml"
    if path.exists():
        cfg = yaml.safe_load(path.read_text())
        for key in ("slug", "country", "region", "bbox"):
            if key not in cfg:
                sys.exit(f"{path}: missing `{key}`")
        return cfg
    found = sorted((REPO_ROOT / "registry").glob(f"*/*/{slug}/place.json"))
    if not found:
        sys.exit(f"no resort config at {path} and no registry/*/*/{slug}/place.json")
    place = json.loads(found[0].read_text())
    at = place.get("coordinates") or {}
    if "latitude" not in at or "longitude" not in at:
        sys.exit(f"{found[0]}: no coordinates to centre a bbox on; add {path}")
    lat, lng = at["latitude"], at["longitude"]
    dlat = DEFAULT_BOX_M / 111_320
    dlng = dlat / math.cos(math.radians(lat))
    return {
        "slug": slug, "country": found[0].parts[-4], "region": found[0].parts[-3],
        "bbox": [round(lat - dlat, 4), round(lng - dlng, 4), round(lat + dlat, 4), round(lng + dlng, 4)],
    }


def fetch_osm(cfg: dict, refresh: bool) -> list[dict]:
    cache = CACHE_DIR / f"{cfg['slug']}-graph-osm.json"
    if cache.exists() and not refresh:
        return json.loads(cache.read_text())["elements"]
    s, w, n, e = cfg["bbox"]
    query = f"""[out:json][timeout:60];
(way["piste:type"="downhill"]({s},{w},{n},{e});way["aerialway"]({s},{w},{n},{e}););
(._;>;);out body;"""
    # Overpass turns away clients that don't say who they are, and the
    # public servers time out under load: try each, twice.
    resp = None
    for url in OVERPASS_URLS * 2:
        try:
            resp = requests.post(url, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=90)
        except requests.RequestException:
            continue
        if resp.status_code == 200:
            break
        time.sleep(5)
    if resp is None:
        sys.exit("Overpass is unreachable")
    resp.raise_for_status()
    CACHE_DIR.mkdir(exist_ok=True)
    cache.write_text(resp.text)
    return resp.json()["elements"]


def fetch_elevations(slug: str, points: dict[int, tuple[float, float]]) -> dict[int, float]:
    cache = CACHE_DIR / f"{slug}-graph-elevation.json"
    known: dict[str, float] = json.loads(cache.read_text()) if cache.exists() else {}
    todo = [i for i in points if str(i) not in known]
    for at in range(0, len(todo), 100):
        batch = todo[at:at + 100]
        params = {
            "latitude": ",".join(f"{points[i][0]:.6f}" for i in batch),
            "longitude": ",".join(f"{points[i][1]:.6f}" for i in batch),
        }
        # The free endpoint answers 429 when asked too fast; wait and go on.
        for wait in (0, 15, 60, 120):
            time.sleep(wait)
            resp = requests.get(ELEVATION_URL, params=params, timeout=30)
            if resp.status_code != 429:
                break
        resp.raise_for_status()
        for i, alt in zip(batch, resp.json()["elevation"]):
            known[str(i)] = alt
        CACHE_DIR.mkdir(exist_ok=True)
        cache.write_text(json.dumps(known))
    return {i: known[str(i)] for i in points}


def norm(name: str | None) -> str:
    """`Rainbow III`, `레인보우 3` and `rainbow-3` all compare equal to their own language's form."""
    if not name:
        return ""
    words = re.findall(r"[^\W_]+", name.lower())
    return "".join(ROMAN.get(w, w) for w in words)


def catalog(place_dir: Path, file: str, key: str) -> list[dict]:
    path = place_dir / file
    if not path.exists():
        return []
    rows = json.loads(path.read_text()).get(key, [])
    out = []
    for r in rows:
        names = {norm(r.get("name")), norm(str(r.get("id")))}
        names |= {norm(v) for v in (r.get("name_i18n") or {}).values()}
        line = [(c["lat"], c["lon"]) for c in r.get("coordinates") or [] if "lat" in c and "lon" in c]
        out.append({"id": str(r["id"]), "names": names - {""}, "line": line, "difficulty": r.get("difficulty")})
    return out


def neighbours(cfg: dict, plane: Plane) -> list[list[tuple[float, float]]]:
    """Slope and lift lines of every other resort in the region, to tell their ways from ours."""
    region = REPO_ROOT / "registry" / cfg["country"] / cfg["region"]
    lines = []
    for other in sorted(region.iterdir()):
        if not other.is_dir() or other.name == cfg["slug"]:
            continue
        for file, key in (("slopes.json", "slopes"), ("lifts.json", "lifts")):
            lines += [row["line"] for row in catalog(other, file, key) if len(row["line"]) >= 2]
    s, w, n, e = cfg["bbox"]
    return [l for l in lines if any(s <= p[0] <= n and w <= p[1] <= e for p in l)]


def match_catalog(way: dict, pts, rows: list[dict], plane: Plane) -> dict | None:
    """Which catalog record is this OSM way: by the way id in the record id, then by name, then by where it lies."""
    wid = str(way["id"])
    for r in rows:
        if wid in r["id"]:
            return r
    tags = way["tags"]
    names = {norm(tags.get(k)) for k in ("name", "name:en", "name:ko", "name:ja")} - {""}
    for r in rows:
        if names & r["names"]:
            return r
    best = None
    for r in rows:
        if len(r["line"]) < 2:
            continue
        d = plane.mean_to_line(pts, r["line"])
        if d <= CATALOG_MATCH_M and (best is None or d < best[0]):
            best = (d, r)
    return best[1] if best else None


def read_track(path: str) -> list[tuple[float, float, float, float]]:
    """(epoch seconds, lat, lng, altitude) per fix."""
    if path.endswith(".slopes"):
        rows = []
        for line in zipfile.ZipFile(path).read("GPS.csv").decode().splitlines():
            c = line.split(",")
            try:
                rows.append((float(c[0]), float(c[1]), float(c[2]), float(c[3])))
            except (ValueError, IndexError):
                continue
        return rows
    if path.endswith(".gpx"):
        text = Path(path).read_text(errors="ignore")
        rows = []
        for m in re.finditer(r'<trkpt[^>]*lat="([^"]+)"[^>]*lon="([^"]+)"[^>]*>(.*?)</trkpt>', text, re.S):
            ele = re.search(r"<ele>([^<]+)</ele>", m.group(3))
            when = re.search(r"<time>([^<]+)</time>", m.group(3))
            if not ele or not when:
                continue
            t = dt.datetime.fromisoformat(when.group(1).replace("Z", "+00:00")).timestamp()
            rows.append((t, float(m.group(1)), float(m.group(2)), float(ele.group(1))))
        return rows
    return []


def track_files(spec: list[str]) -> list[str]:
    files: set[str] = set()
    for s in spec:
        p = os.path.expanduser(s)
        if os.path.isdir(p):
            files |= set(glob.glob(os.path.join(p, "*.slopes"))) | set(glob.glob(os.path.join(p, "*.gpx")))
        else:
            files |= set(glob.glob(p))
    return sorted(files)


# ── the graph ─────────────────────────────────────────────────────────

class Edge:
    def __init__(self, way: dict, kind: str, nodes: list[int]):
        self.way = way
        self.kind = kind
        self.nodes = nodes
        self.rides = 0

    @property
    def key(self):
        return (self.way["id"], self.nodes[0], self.nodes[-1])


class Matcher:
    """Nearest edge of a kind to a point, by a grid of the edges' segments."""

    CELL = 150

    def __init__(self, edges: list[Edge], pos: dict[int, tuple[float, float]], plane: Plane):
        self.edges, self.pos, self.plane = edges, pos, plane
        self.segs = []
        self.grid = collections.defaultdict(list)
        for ei, e in enumerate(edges):
            for k, (a, b) in enumerate(zip(e.nodes, e.nodes[1:])):
                (ax, ay), (bx, by) = plane.xy(pos[a]), plane.xy(pos[b])
                si = len(self.segs)
                self.segs.append((ei, k, pos[a], pos[b]))
                for gx in range(int(min(ax, bx) // self.CELL) - 1, int(max(ax, bx) // self.CELL) + 2):
                    for gy in range(int(min(ay, by) // self.CELL) - 1, int(max(ay, by) // self.CELL) + 2):
                        self.grid[(gx, gy)].append(si)

    def nearest(self, p, kind: str, reach: float):
        """(edge index, vertex index along it) or None."""
        x, y = self.plane.xy(p)
        best = (reach, None, None)
        for si in self.grid.get((int(x // self.CELL), int(y // self.CELL)), ()):
            ei, k, a, b = self.segs[si]
            if self.edges[ei].kind != kind:
                continue
            d = self.plane.to_segment(p, a, b)
            if d <= best[0]:
                nearer_b = self.plane.dist(p, b) < self.plane.dist(p, a)
                best = (d, ei, k + 1 if nearer_b else k)
        return None if best[1] is None else (best[1], best[2])


def legs(gps: list) -> list[tuple[str, int, int]]:
    """Cut a day into climbs and descents: ("lift" | "slope", first index, last index).

    Fix-by-fix altitude is too noisy to say which way a rider is going (a
    phone's altitude jumps 20 m between fixes), so the altitude is smoothed
    and a leg only turns once it has gone LEG_TURN_M the other way.
    """
    if len(gps) < 2:
        return []
    smooth = []
    lo = hi = 0
    for i, g in enumerate(gps):
        while g[0] - gps[lo][0] > SMOOTH_S:
            lo += 1
        while hi + 1 < len(gps) and gps[hi + 1][0] - g[0] <= SMOOTH_S:
            hi += 1
        smooth.append(sum(x[3] for x in gps[lo:hi + 1]) / (hi - lo + 1))
    out = []
    start = top = bottom = 0
    going = 0
    for i, alt in enumerate(smooth):
        if alt > smooth[top]:
            top = i
        if alt < smooth[bottom]:
            bottom = i
        if going >= 0 and alt <= smooth[top] - LEG_TURN_M:
            if going > 0:
                out.append(("lift", start, top))
            start, going, bottom = top, -1, i
        elif going <= 0 and alt >= smooth[bottom] + LEG_TURN_M:
            if going < 0:
                out.append(("slope", start, bottom))
            start, going, top = bottom, 1, i
    if going:
        out.append(("lift" if going > 0 else "slope", start, len(gps) - 1))
    return out


def observe(edges: list[Edge], pos, plane: Plane, tracks: list[list], bbox):
    """Ride the tracks over the edges.

    Returns (rides per edge, forward-minus-backward votes per edge,
    transitions {(a, b): [(exit vertex on a, entry vertex on b)]},
    days that had any fix in the area).
    """
    m = Matcher(edges, pos, plane)
    rides = collections.Counter()
    votes = collections.Counter()
    trans = collections.defaultdict(list)
    days = 0
    s, w, n, e = bbox
    for gps in tracks:
        gps = [g for g in gps if s <= g[1] <= n and w <= g[2] <= e]
        if not gps:
            continue
        days += 1
        prev = None        # (edge, last vertex, last point) of the last confirmed ride
        for kind, a, b in legs(gps):
            reach = LIFT_REACH_M if kind == "lift" else SLOPE_REACH_M
            run = None     # edge being confirmed
            count = 0
            first_v = None
            for t, la, lo, _ in gps[a:b + 1]:
                hit = m.nearest((la, lo), kind, reach)
                if hit is None:
                    continue
                ei, v = hit
                if prev is not None and prev[0] == ei:
                    votes[ei] += (v > prev[1]) - (v < prev[1])
                    prev = (ei, v, (la, lo))
                    run = ei
                    continue
                if ei == run:
                    count += 1
                else:
                    run, count, first_v = ei, 1, v
                if count == RIDE_MIN_POINTS:
                    rides[ei] += 1
                    votes[ei] += (v > first_v) - (v < first_v)
                    reached = _span(edges[ei], first_v, v, pos, plane)
                    if prev is not None and plane.dist(prev[2], (la, lo)) <= TRANSITION_GAP_M + reached:
                        trans[(prev[0], ei)].append((prev[1], first_v))
                    prev = (ei, v, (la, lo))
    return rides, votes, trans, days


def _span(edge: Edge, a: int, b: int, pos, plane: Plane) -> float:
    lo, hi = sorted((a, b))
    return plane.length([pos[n] for n in edge.nodes[lo:hi + 1]])


def along(edge: Edge, v: int, pos, plane: Plane, from_end: bool) -> float:
    pts = [pos[n] for n in (edge.nodes[v:] if from_end else edge.nodes[:v + 1])]
    return plane.length(pts) if len(pts) > 1 else 0.0


def build(cfg: dict, tracks: list[list], refresh: bool, directed: dict[int, int] | None = None):
    elements = fetch_osm(cfg, refresh)
    pos = {e["id"]: (e["lat"], e["lon"]) for e in elements if e["type"] == "node"}
    plane = Plane(sum(p[0] for p in pos.values()) / len(pos))
    place_dir = REPO_ROOT / "registry" / cfg["country"] / cfg["region"] / cfg["slug"]
    slopes = catalog(place_dir, "slopes.json", "slopes")
    lifts = catalog(place_dir, "lifts.json", "lifts")
    others = neighbours(cfg, plane)
    notes: list[str] = []

    # 2. Keep.
    ways = []
    skip = set((cfg.get("graph") or {}).get("exclude_osm_ways") or [])
    for w in (e for e in elements if e["type"] == "way"):
        tags = w.get("tags") or {}
        kind = "slope" if tags.get("piste:type") == "downhill" else "lift" if tags.get("aerialway") in LIFT_TYPES else None
        if kind is None or tags.get("area") == "yes" or w["id"] in skip or len(w["nodes"]) < 2:
            continue
        pts = [pos[n] for n in w["nodes"]]
        rec = match_catalog(w, pts, slopes if kind == "slope" else lifts, plane)
        if rec is None or str(w["id"]) not in rec["id"]:
            theirs = min((plane.mean_to_line(pts, l) for l in others), default=1e9)
            ours = plane.mean_to_line(pts, rec["line"]) if rec and len(rec["line"]) >= 2 else 1e9
            if theirs <= NEIGHBOUR_MATCH_M and theirs < ours:
                notes.append(f"left out OSM way {w['id']} ({tags.get('name', 'unnamed')}): it lies on a neighbouring resort's line")
                continue
        ways.append({"way": w, "kind": kind, "rec": rec})

    # 3. Split slopes at shared nodes.
    use = collections.Counter(n for x in ways for n in set(x["way"]["nodes"]))
    edges: list[Edge] = []
    for x in ways:
        nodes = x["way"]["nodes"]
        cuts = [0] + [i for i, n in enumerate(nodes[1:-1], 1) if use[n] > 1 and x["kind"] == "slope"] + [len(nodes) - 1]
        for a, b in zip(cuts, cuts[1:]):
            e = Edge(x["way"], x["kind"], nodes[a:b + 1])
            e.rec = x["rec"]
            edges.append(e)

    # 4. Elevate.
    used = {n for e in edges for n in e.nodes}
    alt = fetch_elevations(cfg["slug"], {n: pos[n] for n in used})

    # 5 + 6a. First pass over the tracks: direction votes and transitions.
    # Only fixes around the kept lines count, whatever else the day held.
    lats = [pos[n][0] for n in used]
    lngs = [pos[n][1] for n in used]
    pad_lat, pad_lng = TRACK_MARGIN_M / plane.ky, TRACK_MARGIN_M / plane.kx
    area = (min(lats) - pad_lat, min(lngs) - pad_lng, max(lats) + pad_lat, max(lngs) + pad_lng)
    rides, votes, trans, days = observe(edges, pos, plane, tracks, area)

    way_votes = collections.Counter()
    way_rides = collections.Counter()
    for i, e in enumerate(edges):
        way_votes[e.way["id"]] += votes[i]
        way_rides[e.way["id"]] += rides[i]
    flipped_ways = set()
    unsure_ways = set()
    two_way = set()
    for x in ways:
        w = x["way"]
        drop = alt[w["nodes"][0]] - alt[w["nodes"][-1]]
        want_forward = drop >= 0 if x["kind"] == "slope" else drop <= 0
        v = way_votes[w["id"]]
        if way_rides[w["id"]] >= DIRECTION_MIN_RIDES and v != 0:
            seen_forward = v > 0
            if seen_forward != want_forward:
                notes.append(f"OSM way {w['id']} ({w['tags'].get('name', 'unnamed')}): tracks ride it against the DEM's fall "
                             f"({abs(drop):.0f} m by elevation); kept the ridden direction")
            want_forward = seen_forward
        elif abs(drop) < SURE_DROP_M:
            unsure_ways.add(w["id"])
        if directed and w["id"] in directed:
            want_forward = directed[w["id"]] == w["nodes"][0]
        if not want_forward:
            flipped_ways.add(w["id"])
        if w["tags"].get("oneway") == "no" and x["kind"] == "slope":
            two_way.add(w["id"])

    # 6b. Transitions between edges that don't touch become cuts + traverses.
    def end_node(i, v, leaving: bool):
        """The node a rider used on edge i: an end when they were near it, else the vertex itself (a cut)."""
        e = edges[i]
        forward = e.way["id"] not in flipped_ways
        tail = (len(e.nodes) - 1) if (leaving == forward) else 0
        if e.kind == "lift":
            return e.nodes[tail], None
        to_tail = along(e, v, pos, plane, from_end=(tail != 0))
        if to_tail <= END_SLACK_M:
            return e.nodes[tail], None
        return e.nodes[v], v

    cuts = collections.defaultdict(set)
    links = collections.Counter()
    dropped = []
    for (a, b), seen in trans.items():
        if a == b:
            continue
        exit_v = int(statistics.median_low([s[0] for s in seen]))
        entry_v = int(statistics.median_low([s[1] for s in seen]))
        na, cut_a = end_node(a, exit_v, leaving=True)
        nb, cut_b = end_node(b, entry_v, leaving=False)
        if na == nb:
            continue  # they touch in OSM; nothing to add
        needs_split = cut_a is not None or cut_b is not None
        with_lift = "lift" in (edges[a].kind, edges[b].kind)
        need = LINK_MIN if not needs_split else SPLIT_MIN_WITH_LIFT if with_lift else SPLIT_MIN_SLOPE_TO_SLOPE
        gap = plane.dist(pos[na], pos[nb])
        if len(seen) < need or gap > TRANSITION_GAP_M:
            dropped.append((len(seen), a, b, gap))
            continue
        if cut_a is not None and 0 < cut_a < len(edges[a].nodes) - 1:
            cuts[a].add(cut_a)
        if cut_b is not None and 0 < cut_b < len(edges[b].nodes) - 1:
            cuts[b].add(cut_b)
        links[(na, nb)] += len(seen)

    final: list[Edge] = []
    for i, e in enumerate(edges):
        at = [0] + sorted(cuts[i]) + [len(e.nodes) - 1]
        for a, b in zip(at, at[1:]):
            part = Edge(e.way, e.kind, e.nodes[a:b + 1])
            part.rec = e.rec
            # The id is taken before orienting, so correcting a direction never renames the edge.
            part.id = f"e-{e.way['id']}-{e.nodes[a]}"
            part.unsure = e.way["id"] in unsure_ways
            final.append(part)
    for e in final:
        if e.way["id"] in flipped_ways:
            e.nodes = e.nodes[::-1]

    # Second pass, only for ride counts on the final edges.
    rides2, _, _, _ = observe(final, pos, plane, tracks, area)
    for i, e in enumerate(final):
        e.rides = rides2[i]

    return {
        "edges": final, "links": links, "pos": pos, "alt": alt, "plane": plane, "two_way": two_way,
        "days": days, "notes": notes, "dropped": [(c, edges[a], edges[b], gap) for c, a, b, gap in dropped],
        "have_tracks": bool(tracks),
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("slug")
    ap.add_argument("--tracks", nargs="*", default=[], help="track files, globs or directories (.slopes, .gpx)")
    ap.add_argument("--refresh", action="store_true", help="refetch OSM instead of using the cache")
    ap.add_argument("--dry-run", action="store_true", help="print the summary, write nothing to the registry")
    args = ap.parse_args()

    cfg = load_config(args.slug)
    tracks = [t for t in (read_track(f) for f in track_files(args.tracks)) if t]
    place_dir = REPO_ROOT / "registry" / cfg["country"] / cfg["region"] / cfg["slug"]
    corrections = slope_graph_emit.load_corrections(place_dir)
    g = build(cfg, tracks, args.refresh, slope_graph_emit.forced_directions(corrections))
    g["alt"].update(fetch_elevations(cfg["slug"], {n: g["pos"][n] for e in g["edges"] for n in e.nodes}))
    doc, review, items = slope_graph_emit.emit(cfg, g, corrections)
    print(review.split("\n## ")[0])
    REVIEW_DIR.mkdir(exist_ok=True)
    (REVIEW_DIR / f"{args.slug}-graph.md").write_text(review)
    (REVIEW_DIR / f"{args.slug}-graph-items.json").write_text(json.dumps(items, ensure_ascii=False, indent=1))
    if args.dry_run:
        (REVIEW_DIR / f"{args.slug}-graph.json").write_text(json.dumps(doc, ensure_ascii=False))
        return
    out = place_dir / "slope-graph.json"
    out.write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n")
    print(f"wrote {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
