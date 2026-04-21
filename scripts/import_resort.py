#!/usr/bin/env python3
"""
Import a resort's slopes + lifts from OpenStreetMap into the open-ski-data
registry.

Pipeline:
  1. Fetch  — Overpass query by bbox → raw OSM ways + nodes.
  2. Split  — break ways at shared nodes so every junction is an
              explicit edge boundary.
  3. Elevate — sample each vertex against the DEM path in the resort
              config (GeoTIFF). Missing altitude is left as null; the
              end-of-run review lists them.
  4. Densify — linearly interpolate any edge where consecutive
              vertices are > max_gap_m apart so the trail-snap HMM
              has enough emission density.
  5. Normalize — difficulty via OSM tag + user overrides; name:ko /
              name:en / name cascade. Same slope name → one slope_id
              (coordinates list preserves segment ordering).
  6. Write — emits `registry/<country>/<region>/<slug>.slopes.json`
              and `.lifts.json` in place.
  7. Review — writes `scripts/review/<slug>.md` summarizing everything
              a human needs to look at (missing data, low-confidence
              tags, elevation holes, suspected missing surface lifts).

Designed so the only manual step is reading the review markdown once,
making edits to the resort YAML + override sections, and re-running.

Usage:
  python scripts/import_resort.py yongpyong
  python scripts/import_resort.py --dry-run yongpyong      # skip file writes
  python scripts/import_resort.py --all                    # import every resort yaml

Requires:
  pip install -r scripts/requirements.txt
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Optional

import requests
import yaml

try:
    import rasterio
except ImportError:
    rasterio = None  # type: ignore[assignment]


REPO_ROOT = Path(__file__).resolve().parent.parent
RESORT_DIR = Path(__file__).resolve().parent / "resorts"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
REVIEW_DIR = Path(__file__).resolve().parent / "review"

OVERPASS_URL = "https://overpass-api.de/api/interpreter"

# OSM difficulty → our enum. Known KR resort colour conventions sit
# somewhere between the SkiWatch levels and European pistes; use the
# conservative mapping below and override per-resort where it matters.
OSM_DIFFICULTY_MAP = {
    "novice": "beginner",
    "easy": "beginner",
    "intermediate": "intermediate",
    "advanced": "advanced",
    "expert": "expert",
    "extreme": "expert",
    "freeride": "expert",
}

VALID_DIFFICULTIES = {
    "beginner", "be_in", "intermediate", "in_ad",
    "advanced", "expert", "pro", "park",
}

# Vertex spacing in meters — densify anything wider than this so the
# trail-snap HMM sees enough emissions per edge.
DENSIFY_MAX_GAP_M = 30.0


# ── data model ──────────────────────────────────────────────────────

@dataclass
class ResortConfig:
    slug: str
    country: str
    region: str
    bbox: tuple[float, float, float, float]  # min_lat, min_lng, max_lat, max_lng
    dem: Optional[str] = None
    densify_max_gap_m: float = DENSIFY_MAX_GAP_M
    difficulty_overrides: dict[str, str] = field(default_factory=dict)
    name_overrides: dict[str, str] = field(default_factory=dict)

    @classmethod
    def load(cls, slug: str) -> "ResortConfig":
        path = RESORT_DIR / f"{slug}.yaml"
        if not path.exists():
            die(f"No resort config at {path}. Create one with minimum fields: "
                "slug, country, region, bbox, dem.")
        data = yaml.safe_load(path.read_text())
        bbox = data.get("bbox")
        if not (isinstance(bbox, list) and len(bbox) == 4):
            die(f"{path}: bbox must be [min_lat, min_lng, max_lat, max_lng]")
        return cls(
            slug=data["slug"],
            country=data["country"].lower(),
            region=data["region"],
            bbox=tuple(bbox),  # type: ignore[arg-type]
            dem=data.get("dem"),
            densify_max_gap_m=float(data.get("densify_max_gap_m", DENSIFY_MAX_GAP_M)),
            difficulty_overrides=data.get("difficulty_overrides") or {},
            name_overrides={str(k): v for k, v in (data.get("name_overrides") or {}).items()},
        )


@dataclass
class Review:
    """Single-pass reviewable findings — everything that needs a human
    is dumped here and written to scripts/review/<slug>.md at the end."""
    lines: list[str] = field(default_factory=list)
    missing_altitude: int = 0
    missing_difficulty: list[str] = field(default_factory=list)
    suspected_missing_lifts: list[str] = field(default_factory=list)

    def warn(self, msg: str) -> None:
        self.lines.append(f"- ⚠ {msg}")

    def info(self, msg: str) -> None:
        self.lines.append(f"- {msg}")


# ── Overpass fetch ──────────────────────────────────────────────────

def overpass_query(bbox: tuple[float, float, float, float]) -> str:
    min_lat, min_lng, max_lat, max_lng = bbox
    # Pull pistes + all lift types inside the bbox. `(._;>;)` expands
    # each way to its nodes so we can sample geometry.
    return f"""
[out:json][timeout:60];
(
  way["piste:type"="downhill"]({min_lat},{min_lng},{max_lat},{max_lng});
  way["piste:type"="skitour"]({min_lat},{min_lng},{max_lat},{max_lng});
  way["piste:type"="nordic"]({min_lat},{min_lng},{max_lat},{max_lng});
  way["piste:type"="connection"]({min_lat},{min_lng},{max_lat},{max_lng});
  way["aerialway"]({min_lat},{min_lng},{max_lat},{max_lng});
);
(._;>;);
out body;
""".strip()


def fetch_osm(cfg: ResortConfig, review: Review, use_cache: bool = True) -> dict[str, Any]:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    cache = CACHE_DIR / f"{cfg.slug}.osm.json"
    if use_cache and cache.exists():
        review.info(f"Using cached Overpass response ({cache.name}) — delete to re-fetch")
        return json.loads(cache.read_text())

    print(f"→ Overpass fetch for {cfg.slug} bbox={cfg.bbox}")
    # Overpass requires a User-Agent that identifies the requester.
    # Generic Python UA gets 406. 429 rate-limits get exponential backoff
    # so `--all` doesn't bail after one throttled request.
    headers = {"User-Agent": "open-ski-data importer (https://github.com/powder-nomad/open-ski-data)"}
    payload = {"data": overpass_query(cfg.bbox)}
    delay = 5.0
    for attempt in range(5):
        resp = requests.post(OVERPASS_URL, data=payload, headers=headers, timeout=180)
        if resp.status_code in (429, 504, 502):
            import time
            review.info(f"Overpass {resp.status_code} on attempt {attempt + 1} — sleeping {delay:.0f}s")
            time.sleep(delay)
            delay *= 2
            continue
        resp.raise_for_status()
        data = resp.json()
        cache.write_text(json.dumps(data, separators=(",", ":")))
        return data
    resp.raise_for_status()
    raise RuntimeError("unreachable")


# ── split at junctions ──────────────────────────────────────────────

@dataclass
class OsmNode:
    id: int
    lat: float
    lng: float


@dataclass
class OsmWay:
    id: int
    tags: dict[str, str]
    node_ids: list[int]


def parse_osm(raw: dict[str, Any]) -> tuple[dict[int, OsmNode], list[OsmWay]]:
    nodes: dict[int, OsmNode] = {}
    ways: list[OsmWay] = []
    for elem in raw.get("elements", []):
        if elem["type"] == "node":
            nodes[elem["id"]] = OsmNode(elem["id"], elem["lat"], elem["lon"])
        elif elem["type"] == "way":
            ways.append(OsmWay(elem["id"], elem.get("tags") or {}, elem.get("nodes") or []))
    return nodes, ways


def split_at_junctions(ways: list[OsmWay]) -> list[OsmWay]:
    """Split each way at any node shared with another way (excluding
    endpoints, which are trivially shared). The resulting edges are
    guaranteed to have non-shared interior nodes — every junction is
    an explicit boundary."""
    node_count: dict[int, int] = {}
    for w in ways:
        for nid in w.node_ids:
            node_count[nid] = node_count.get(nid, 0) + 1

    split: list[OsmWay] = []
    for w in ways:
        if len(w.node_ids) < 2:
            continue
        # Split points are interior nodes that appear on another way.
        breakpoints = [i for i, nid in enumerate(w.node_ids)
                       if 0 < i < len(w.node_ids) - 1 and node_count[nid] > 1]
        if not breakpoints:
            split.append(w)
            continue
        start = 0
        for idx in breakpoints + [len(w.node_ids) - 1]:
            segment = w.node_ids[start:idx + 1]
            if len(segment) >= 2:
                split.append(OsmWay(id=int(f"{w.id}{start:02d}"), tags=dict(w.tags), node_ids=segment))
            start = idx
    return split


# ── elevation ───────────────────────────────────────────────────────

class ElevationSampler:
    def __init__(self, dem_path: Optional[str], review: Review):
        self.dataset = None
        self.nodata = None
        self.review = review
        if not dem_path:
            review.warn("No DEM configured — elevations will be null. Set `dem:` in the resort YAML to fill them.")
            return
        if rasterio is None:
            review.warn("rasterio not installed — elevations skipped. `pip install rasterio`.")
            return
        path = Path(dem_path)
        if not path.is_absolute():
            path = REPO_ROOT / dem_path
        if not path.exists():
            review.warn(f"DEM path {path} not found — elevations skipped.")
            return
        self.dataset = rasterio.open(path)
        self.nodata = self.dataset.nodata

    def sample(self, lat: float, lng: float) -> Optional[float]:
        if self.dataset is None:
            return None
        try:
            # rasterio sample() expects (x=lng, y=lat) pairs.
            for val in self.dataset.sample([(lng, lat)]):
                if val[0] is None:
                    return None
                if self.nodata is not None and float(val[0]) == float(self.nodata):
                    return None
                return float(val[0])
        except Exception:  # noqa: BLE001 — DEM read failures should never crash the pipeline
            return None
        return None


# ── densify ─────────────────────────────────────────────────────────

def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def densify_polyline(pts: list[tuple[float, float]], max_gap_m: float) -> list[tuple[float, float]]:
    if len(pts) < 2:
        return pts
    out: list[tuple[float, float]] = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        d = haversine_m(a[0], a[1], b[0], b[1])
        if d <= max_gap_m:
            out.append(b)
            continue
        steps = int(math.ceil(d / max_gap_m))
        for k in range(1, steps):
            t = k / steps
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
        out.append(b)
    return out


def polyline_length_m(pts: list[tuple[float, float]]) -> float:
    return sum(haversine_m(a[0], a[1], b[0], b[1]) for a, b in zip(pts, pts[1:]))


# ── normalize + group ───────────────────────────────────────────────

SLUG_RE = re.compile(r"[^a-z0-9]+")


def slugify(text: str) -> str:
    s = SLUG_RE.sub("-", text.lower()).strip("-")
    return s or "unnamed"


def pick_names(tags: dict[str, str], name_overrides: dict[str, str], osm_id: int) -> tuple[str, dict[str, str]]:
    override = name_overrides.get(str(osm_id))
    if override:
        return override, {"en": override}
    name_ko = tags.get("name:ko")
    name_en = tags.get("name:en")
    name_ja = tags.get("name:ja")
    name_default = tags.get("name")
    canonical = name_en or name_default or name_ko or f"unnamed-{osm_id}"
    i18n: dict[str, str] = {}
    if name_ko:
        i18n["ko"] = name_ko
    if name_en:
        i18n["en"] = name_en
    if name_ja:
        i18n["ja"] = name_ja
    if name_default and not i18n:
        i18n["en"] = name_default
    return canonical, i18n


def pick_difficulty(tags: dict[str, str], overrides: dict[str, str], slope_slug: str, review: Review, slope_name: str) -> Optional[str]:
    override = overrides.get(slope_slug)
    if override:
        if override not in VALID_DIFFICULTIES:
            review.warn(f"difficulty override `{override}` for `{slope_slug}` not in enum")
            return None
        return override
    raw = (tags.get("piste:difficulty") or "").lower()
    mapped = OSM_DIFFICULTY_MAP.get(raw)
    if raw and not mapped:
        review.warn(f"unknown OSM difficulty `{raw}` on `{slope_name}` — left null")
    if not mapped:
        review.missing_difficulty.append(slope_slug)
    return mapped


# ── main build ──────────────────────────────────────────────────────

def build_slopes_and_lifts(cfg: ResortConfig, review: Review) -> tuple[dict[str, Any], dict[str, Any]]:
    raw = fetch_osm(cfg, review)
    nodes, ways = parse_osm(raw)
    if not ways:
        die(f"Overpass returned 0 ways for bbox={cfg.bbox}. Widen the bbox or check the resort location.")

    sampler = ElevationSampler(cfg.dem, review)

    ways = split_at_junctions(ways)
    pistes = [w for w in ways if w.tags.get("piste:type")]
    lifts = [w for w in ways if w.tags.get("aerialway")]
    review.info(f"{len(pistes)} piste segment(s), {len(lifts)} lift segment(s) after junction split")

    # ── lifts ──
    lift_records: list[dict[str, Any]] = []
    lift_endpoints: dict[int, tuple[float, float]] = {}  # lift_id → (lat, lng) of top
    for w in lifts:
        coords = [(nodes[n].lat, nodes[n].lng) for n in w.node_ids if n in nodes]
        if len(coords) < 2:
            continue
        # Densify so downstream viewers have enough vertices to drape
        # the cable convincingly over terrain — default gap same as slopes.
        coords = densify_polyline(coords, cfg.densify_max_gap_m)
        name, i18n = pick_names(w.tags, cfg.name_overrides, w.id)
        length = polyline_length_m(coords)
        top = coords[-1]
        bot = coords[0]
        top_alt = sampler.sample(*top)
        bot_alt = sampler.sample(*bot)
        vertical = None
        if top_alt is not None and bot_alt is not None:
            vertical = round(abs(top_alt - bot_alt), 1)
        lift_type = w.tags.get("aerialway", "")
        # Per-vertex DEM sample so 3D viewers can draw the cable at
        # station altitude. Falls back to null when the DEM has holes —
        # consumers must tolerate nulls (the lift.schema marks alt_m
        # as nullable). The review report already tallies these.
        geometry = [
            {"lat": round(lat, 6), "lon": round(lng, 6), "alt_m": sampler.sample(lat, lng)}
            for lat, lng in coords
        ]
        rec = {
            "id": slugify(name) + f"-l{w.id}",
            "name": name,
            "name_i18n": i18n,
            "type": lift_type,
            "capacity_per_hour": _int_or_none(w.tags.get("aerialway:capacity")),
            "length_m": round(length, 1),
            "vertical_m": vertical,
            "connected_slope_ids": [],  # filled after slopes are built
            "connected_lift_ids": [],
            "coordinates": geometry,
        }
        lift_records.append(rec)
        lift_endpoints[w.id] = top

    # ── pistes → slopes ──
    # Group ways sharing the same canonical name into one slope record
    # (coordinates are the concatenation of segment polylines in OSM order).
    groups: dict[str, dict[str, Any]] = {}
    for w in pistes:
        name, i18n = pick_names(w.tags, cfg.name_overrides, w.id)
        slope_slug = slugify(name)
        coords = [(nodes[n].lat, nodes[n].lng) for n in w.node_ids if n in nodes]
        coords = densify_polyline(coords, cfg.densify_max_gap_m)
        g = groups.setdefault(slope_slug, {
            "id": slope_slug,
            "name": name,
            "name_i18n": i18n,
            "type": "run" if w.tags.get("piste:type") != "connection" else "access_route",
            "difficulty": None,
            "coordinates": [],
            "endpoints": [],  # list of (lat, lng) for junction matching
            "_osm_ids": [],
            "_tags": [],
        })
        # Use the first seen tags for difficulty resolution; later slopes
        # may also contribute if the first was missing.
        g["_tags"].append(w.tags)
        g["_osm_ids"].append(w.id)
        if coords:
            g["coordinates"].extend({"lat": round(lat, 6), "lon": round(lng, 6)} for lat, lng in coords)
            g["endpoints"].append(coords[0])
            g["endpoints"].append(coords[-1])

    slope_records: list[dict[str, Any]] = []
    for slope_slug, g in groups.items():
        # Difficulty: use any tag that carries it, applying overrides.
        difficulty = None
        for tags in g["_tags"]:
            difficulty = pick_difficulty(tags, cfg.difficulty_overrides, slope_slug, review, g["name"])
            if difficulty:
                break
        length = polyline_length_m([(c["lat"], c["lon"]) for c in g["coordinates"]])
        rec = {
            "id": slope_slug,
            "name": g["name"],
            "name_i18n": g["name_i18n"],
            "type": g["type"],
            "difficulty": difficulty,
            "length_m": round(length, 1),
            "connected_slope_ids": [],  # filled below
            "connected_lift_ids": [],
            "coordinates": g["coordinates"],
        }
        slope_records.append((rec, g["endpoints"]))

    # ── connectivity ──
    # A slope is "connected" to another slope if they share an endpoint
    # within 25m (fork / merge). A slope is connected to a lift if the
    # lift's top is within 25m of any slope vertex — that's the mental
    # model for "lift X drops you onto slope Y".
    JUNCTION_RADIUS_M = 25.0
    for i, (a, a_ends) in enumerate(slope_records):
        connected = set()
        for j, (b, b_ends) in enumerate(slope_records):
            if i == j:
                continue
            for pa in a_ends:
                for pb in b_ends:
                    if haversine_m(pa[0], pa[1], pb[0], pb[1]) <= JUNCTION_RADIUS_M:
                        connected.add(b["id"])
        a["connected_slope_ids"] = sorted(connected)

    for lift in lift_records:
        lid = lift["id"]
        top = lift_endpoints.get(_lift_osm_id(lid))
        if not top:
            continue
        connected_slopes = []
        for (s, _ends) in slope_records:
            for c in s["coordinates"]:
                if haversine_m(top[0], top[1], c["lat"], c["lon"]) <= JUNCTION_RADIUS_M:
                    connected_slopes.append(s["id"])
                    break
        lift["connected_slope_ids"] = sorted(set(connected_slopes))

    # Back-populate connected_lift_ids on slopes.
    slope_to_lifts: dict[str, list[str]] = {}
    for lift in lift_records:
        for sid in lift["connected_slope_ids"]:
            slope_to_lifts.setdefault(sid, []).append(lift["id"])
    for (s, _ends) in slope_records:
        s["connected_lift_ids"] = sorted(set(slope_to_lifts.get(s["id"], [])))

    # Heuristic: surface lifts at a beginner area are often missing from
    # OSM. If a resort has lots of beginner slopes but no lifts, flag it.
    beginner_slopes = sum(1 for s, _ in slope_records if s.get("difficulty") == "beginner")
    if beginner_slopes >= 3 and len(lift_records) < 2:
        review.warn(f"{beginner_slopes} beginner slope(s) but only {len(lift_records)} lift(s) — "
                    "surface lifts (magic carpets) likely missing from OSM; add via config")

    # Missing-altitude count report.
    if sampler.dataset is None:
        review.missing_altitude = sum(len(s["coordinates"]) for s, _ in slope_records)

    slopes_out = {
        "country_code": cfg.country,
        "region_slug": cfg.region,
        "place_slug": cfg.slug,
        "slopes": [strip_internal(s) for (s, _) in slope_records],
    }
    lifts_out = {
        "country_code": cfg.country,
        "region_slug": cfg.region,
        "place_slug": cfg.slug,
        "lifts": lift_records,
    }
    return slopes_out, lifts_out


def strip_internal(rec: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in rec.items() if not k.startswith("_")}


def _int_or_none(v: Optional[str]) -> Optional[int]:
    if v is None:
        return None
    try:
        return int(v)
    except (TypeError, ValueError):
        return None


def _lift_osm_id(lift_id: str) -> Optional[int]:
    # "slugified-name-l<osm_id>" — recover the OSM id to look up endpoint.
    m = re.search(r"-l(\d+)$", lift_id)
    return int(m.group(1)) if m else None


# ── writer ──────────────────────────────────────────────────────────

def write_outputs(cfg: ResortConfig, slopes: dict[str, Any], lifts: dict[str, Any]) -> list[Path]:
    target = REPO_ROOT / "registry" / cfg.country / cfg.region
    target.mkdir(parents=True, exist_ok=True)
    slope_path = target / f"{cfg.slug}.slopes.json"
    lift_path = target / f"{cfg.slug}.lifts.json"
    slope_path.write_text(json.dumps(slopes, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    lift_path.write_text(json.dumps(lifts, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return [slope_path, lift_path]


def write_review(cfg: ResortConfig, review: Review, written: list[Path]) -> Path:
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    path = REVIEW_DIR / f"{cfg.slug}.md"
    lines = [
        f"# Import review — {cfg.slug}",
        "",
        "## Files written",
        *[f"- `{p.relative_to(REPO_ROOT)}`" for p in written],
        "",
        "## Notes",
        *review.lines,
    ]
    if review.missing_difficulty:
        lines += ["", "## Slopes with no difficulty set",
                  "Add entries under `difficulty_overrides:` in the resort YAML, then re-run.",
                  ""]
        for slug in sorted(set(review.missing_difficulty)):
            lines.append(f"- `{slug}:` # pick one of beginner, be_in, intermediate, in_ad, advanced, expert, pro, park")
    if review.missing_altitude:
        lines += ["", f"## Elevation holes: {review.missing_altitude} vertex/vertices missing altitude",
                  "Set `dem:` in the resort YAML to a GeoTIFF covering the bbox and re-run."]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return path


# ── cli ─────────────────────────────────────────────────────────────

def die(msg: str) -> None:
    print(f"✗ {msg}", file=sys.stderr)
    sys.exit(1)


def import_one(slug: str, dry_run: bool) -> None:
    cfg = ResortConfig.load(slug)
    review = Review()
    slopes, lifts = build_slopes_and_lifts(cfg, review)
    written: list[Path] = []
    if not dry_run:
        written = write_outputs(cfg, slopes, lifts)
    review_path = write_review(cfg, review, written)
    print(f"✓ {slug}: {len(slopes['slopes'])} slope(s), {len(lifts['lifts'])} lift(s)")
    print(f"  review: {review_path.relative_to(REPO_ROOT)}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("slug", nargs="?", help="resort slug (matches scripts/resorts/<slug>.yaml)")
    ap.add_argument("--all", action="store_true", help="import every resort yaml in scripts/resorts/")
    ap.add_argument("--dry-run", action="store_true", help="run pipeline but skip file writes")
    args = ap.parse_args()

    if args.all:
        slugs = sorted(p.stem for p in RESORT_DIR.glob("*.yaml"))
    elif args.slug:
        slugs = [args.slug]
    else:
        die("give a slug or --all")

    for slug in slugs:
        import_one(slug, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
