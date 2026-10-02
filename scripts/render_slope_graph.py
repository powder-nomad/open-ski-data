#!/usr/bin/env python3
"""
Draw a slope graph as an SVG for review: slopes with their direction,
lifts, zones, links, and a numbered badge on everything the build flagged
for a person to look at (scripts/review/<slug>-graph-items.json).

Usage:
  python scripts/build_slope_graph.py yongpyong --tracks ~/tracks --dry-run
  python scripts/render_slope_graph.py yongpyong            # the dry run's graph
  python scripts/render_slope_graph.py --published yongpyong  # the one in registry/

Writes scripts/review/<slug>-graph.svg. North is up; altitudes are
printed at lift ends because up the page is not uphill.
"""

from __future__ import annotations

import argparse
import html
import json
import math
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
REVIEW_DIR = Path(__file__).resolve().parent / "review"
WIDTH = 2200
PAD = 60
TOP = 130

SLOPE = "#7dd3fc"
UNRIDDEN = "#5b7682"
LIFT = "#ffffff"
OBSERVED = "#4ade80"
SUGGESTED = "#fbbf24"
UNSURE = "#f472b6"
ZONE = "#4ade80"
BADGE = {"suggested-link": SUGGESTED, "weak-link": OBSERVED, "direction": UNSURE, "zone": ZONE}


def names(place_dir: Path) -> dict[str, str]:
    out = {}
    for file, key in (("slopes.json", "slopes"), ("lifts.json", "lifts")):
        path = place_dir / file
        if path.exists():
            for row in json.loads(path.read_text()).get(key, []):
                out[str(row["id"])] = (row.get("name_i18n") or {}).get("ko") or row.get("name") or str(row["id"])
    return out


def render(doc: dict, items: list[dict], label: dict[str, str]) -> str:
    pts = [(v["lat"], v["lng"]) for e in doc["edges"] for v in e["geometry"]]
    lat0, lat1 = min(p[0] for p in pts), max(p[0] for p in pts)
    lng0, lng1 = min(p[1] for p in pts), max(p[1] for p in pts)
    k = math.cos(math.radians((lat0 + lat1) / 2))
    scale = (WIDTH - 2 * PAD) / ((lng1 - lng0) * k)
    height = int((lat1 - lat0) * scale) + TOP + PAD

    def xy(lat, lng):
        return (lng - lng0) * k * scale + PAD, (lat1 - lat) * scale + TOP

    def line(e, **style):
        points = " ".join("%.1f,%.1f" % xy(v["lat"], v["lng"]) for v in e["geometry"])
        attrs = " ".join(f'{a.replace("_", "-")}="{v}"' for a, v in style.items())
        return f'<polyline points="{points}" fill="none" {attrs}/>'

    def arrow(e, colour, size=9):
        """An arrowhead at the edge's middle, pointing the way it is ridden."""
        g = e["geometry"]
        i = max(1, len(g) // 2)
        (x0, y0), (x1, y1) = xy(g[i - 1]["lat"], g[i - 1]["lng"]), xy(g[i]["lat"], g[i]["lng"])
        length = math.hypot(x1 - x0, y1 - y0) or 1
        ux, uy = (x1 - x0) / length, (y1 - y0) / length
        mx, my = (x0 + x1) / 2, (y0 + y1) / 2
        tip = (mx + ux * size, my + uy * size)
        left = (mx - ux * size - uy * size * 0.7, my - uy * size + ux * size * 0.7)
        right = (mx - ux * size + uy * size * 0.7, my - uy * size - ux * size * 0.7)
        return '<polygon points="%.1f,%.1f %.1f,%.1f %.1f,%.1f" fill="%s"/>' % (*tip, *left, *right, colour)

    node = {n["id"]: n for n in doc["nodes"]}
    unsure_ways = {i["id"] for i in items if i["type"] == "direction"}
    o = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" '
        'style="background:#0f2229;font-family:NanumSquareRound,Pretendard,sans-serif">',
    ]
    for z in doc.get("zones", []):
        at = [xy(node[n]["lat"], node[n]["lng"]) for n in z["nodes"]]
        cx, cy = sum(p[0] for p in at) / len(at), sum(p[1] for p in at) / len(at)
        r = max(math.hypot(p[0] - cx, p[1] - cy) for p in at) + 16
        dash = "" if z["provenance"]["source"] == "user-edit" else ' stroke-dasharray="5 4"'
        o.append(f'<circle cx="{cx:.0f}" cy="{cy:.0f}" r="{r:.0f}" fill="{ZONE}" fill-opacity="0.16" stroke="{ZONE}" stroke-width="1.5"{dash}/>')
    for e in doc["edges"]:
        source = e["provenance"]["source"]
        if e["kind"] == "slope":
            unsure = str(e["provenance"].get("osm_way_id")) in unsure_ways
            colour = UNSURE if unsure else SLOPE if e["provenance"].get("observed_count", 1) > 0 else UNRIDDEN
            o.append(line(e, stroke=colour, stroke_width=3.2))
            if e["length_m"] >= 60 and not e["id"].endswith("-rev"):
                o.append(arrow(e, colour))
        elif e["kind"] == "lift":
            o.append(line(e, stroke=LIFT, stroke_width=1.8, stroke_dasharray="7 6"))
            o.append(arrow(e, LIFT, 8))
    for e in doc["edges"]:
        if e["kind"] != "traverse":
            continue
        source = e["provenance"]["source"]
        if source == "suggested":
            o.append(line(e, stroke=SUGGESTED, stroke_width=2, stroke_dasharray="2 5"))
        else:
            o.append(line(e, stroke=OBSERVED, stroke_width=2.6))
        o.append(arrow(e, SUGGESTED if source == "suggested" else OBSERVED, 7))
    for n in doc["nodes"]:
        x, y = xy(n["lat"], n["lng"])
        o.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="#fff"/>')
        if n.get("kind") in ("lift_top", "lift_bottom"):
            o.append(f'<text x="{x + 7:.0f}" y="{y + 16:.0f}" fill="#94a3b8" font-size="13">{n["alt_m"]:.0f} m</text>')
    seen = set()
    for e in doc["edges"]:
        key = e.get("slope_id") or e.get("lift_id")
        if e["kind"] == "traverse" or not key or key in seen or key.startswith(("unnamed", "osm-")):
            continue
        seen.add(key)
        g = e["geometry"]
        x, y = xy(g[len(g) // 2]["lat"], g[len(g) // 2]["lng"])
        text = html.escape(label.get(key, key)) + (" 리프트" if e["kind"] == "lift" else "")
        o.append(f'<text x="{x + 8:.0f}" y="{y - 6:.0f}" fill="{"#cfefff" if e["kind"] == "slope" else "#fff"}" '
                 f'font-size="17" font-weight="bold" stroke="#0f2229" stroke-width="4" paint-order="stroke">{text}</text>')
    # Badges last, nudged apart so numbers in a crowded base area stay readable.
    placed: list[tuple[float, float]] = []
    for i in items:
        x, y = xy(*i["at"])
        while any(math.hypot(x - px, y - py) < 26 for px, py in placed):
            x += 19
            y -= 17
        placed.append((x, y))
        colour = BADGE.get(i["type"], "#fff")
        o.append(f'<circle cx="{x:.0f}" cy="{y:.0f}" r="13" fill="{colour}" stroke="#0f2229" stroke-width="2"/>'
                 f'<text x="{x:.0f}" y="{y + 5:.0f}" text-anchor="middle" font-size="14" font-weight="bold" fill="#0f2229">{i["n"]}</text>')
    legend = [
        (SLOPE, "slope, arrow = the way it is ridden"), (UNRIDDEN, "slope never ridden in the tracks"), (LIFT, "lift (dashed)"),
        (ZONE, "zone: every end inside reaches every other"), (OBSERVED, "link riders made"),
        (SUGGESTED, "suggested link, never ridden"), (UNSURE, "direction is a guess"),
    ]
    o.append(f'<text x="{PAD}" y="48" fill="#fff" font-size="30" font-weight="bold">{html.escape(doc["place_slug"])}</text>')
    o.append(f'<text x="{PAD + 260}" y="48" fill="#cbd5e1" font-size="17">north is up · numbers at lift ends are altitude · numbered badges need a decision</text>')
    x = PAD
    for colour, text in legend:
        o.append(f'<rect x="{x}" y="72" width="26" height="8" fill="{colour}"/><text x="{x + 34}" y="82" fill="#e2e8f0" font-size="16">{text}</text>')
        x += 60 + len(text) * 8.6
    o.append("</svg>")
    return "\n".join(o)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("slug")
    ap.add_argument("--published", action="store_true", help="draw registry/**/slope-graph.json instead of the last dry run")
    args = ap.parse_args()
    place_dir = next(iter(sorted((REPO_ROOT / "registry").glob(f"*/*/{args.slug}"))), None)
    if place_dir is None:
        raise SystemExit(f"no registry/*/*/{args.slug}")
    source = place_dir / "slope-graph.json" if args.published else REVIEW_DIR / f"{args.slug}-graph.json"
    items_path = REVIEW_DIR / f"{args.slug}-graph-items.json"
    items = json.loads(items_path.read_text()) if items_path.exists() and not args.published else []
    out = REVIEW_DIR / f"{args.slug}-graph.svg"
    out.write_text(render(json.loads(source.read_text()), items, names(place_dir)))
    print(f"wrote {out.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
