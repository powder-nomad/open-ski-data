# Import pipeline

One-command resort import: OpenStreetMap → open-ski-data JSON, with DEM
elevation, junction-split geometry, densified polylines, and a review
report listing anything a human needs to look at.

## Run

```bash
pip install -r scripts/requirements.txt
python scripts/import_resort.py yongpyong        # one resort
python scripts/import_resort.py --all            # every resort yaml
python scripts/import_resort.py --dry-run muju   # no file writes
```

After a run, the only human step is opening
`scripts/review/<slug>.md`, filling in missing overrides in
`scripts/resorts/<slug>.yaml`, and re-running. All manual input is
collected into that single review file — the pipeline never prompts
mid-run.

## Adding a resort

1. Create `scripts/resorts/<slug>.yaml`:

   ```yaml
   slug: <slug>
   country: kr
   region: gangwon          # matches the registry subdirectory
   bbox: [min_lat, min_lng, max_lat, max_lng]  # 3–5 km buffer around the lift network
   dem: dems/<your-geotiff>.tif
   ```

2. `python scripts/import_resort.py <slug>` — writes
   `registry/<country>/<region>/<slug>.slopes.json` and `.lifts.json`
   plus `scripts/review/<slug>.md`.

3. Open the review. Apply any overrides back into the YAML:

   ```yaml
   difficulty_overrides:
     rainbow-1: intermediate
     dragon: advanced
   name_overrides:
     "12345678": "용평 레인보우1"   # OSM way id → canonical KR name
   ```

4. Re-run. Commit.

## Pipeline stages

| Stage | What it does |
|---|---|
| **Fetch** | Overpass query for `piste:type=*` and `aerialway=*` in the bbox. Cached under `scripts/.cache/` — delete to force a refresh. |
| **Split** | Any OSM way node shared with another way becomes a junction; long ways split into per-segment edges so forks/merges are explicit. |
| **Elevate** | Sample every vertex against the DEM (rasterio). Missing values flagged in the review. |
| **Densify** | Linear interpolation so consecutive vertices are ≤30m apart (configurable per resort). |
| **Normalize** | `piste:difficulty` → our enum; `name:ko`/`en`/`ja` cascade; slope name → canonical `slope_id`. |
| **Connect** | Slopes sharing a fork/merge endpoint become `connected_slope_ids`; lift top within 25 m of a slope vertex becomes `connected_lift_ids`. |
| **Write** | Emits schema-valid `.slopes.json` / `.lifts.json` in place. |
| **Review** | One markdown with every warning + override suggestion needing a human. |

## What OSM covers well, poorly, or not at all

| Data | OSM status | What we do |
|---|---|---|
| Slope polylines | ✓ | Use as-is, densified to 30 m |
| Lift endpoints (chair/gondola) | ✓ | Use as-is |
| Lift tower positions (mid-cable) | ✗ | We render as 2-point segments — fine for trail-snap |
| Magic carpets / rope tows | ⚠ often missing | Review flags suspected-missing; add via YAML later |
| Elevation | ✗ no node altitude | DEM sampling fills this |
| Fork / merge nodes | ⚠ implicit | Junction-split pass makes them explicit |
| Slope difficulty | ⚠ mapper-inconsistent | Override file aligns with the resort's official colours |
| Seasonal closed status | ✗ | Out of scope — Slopecast handles live status |

## Re-runs

Re-running is idempotent — stable IDs + diff-friendly ordering — so you
can safely regenerate after upstream OSM edits or override tweaks and
review the diff.

## Debugging slope-graphs

Two authoring aids for reviewing a `<slug>.slope-graph.json`:

### CLI tree view

```bash
node scripts/view-slope-graph.mjs yongpyong              # coloured tree
node scripts/view-slope-graph.mjs --no-color yongpyong   # plain for logs
node scripts/view-slope-graph.mjs --json yongpyong       # derived chain dump
```

Prints a per-slope tree — consecutive segments listed top-to-bottom,
forks shown as `├ branch 1 / └ branch 2` with their merge node noted.
Slopes are sorted by top-node altitude descending, matching how a
skier reads a trail map. Difficulty and length are annotated on each
edge.

### 3D web viewer

```bash
python3 -m http.server -d scripts/viewer 8090
# open "http://127.0.0.1:8090/?slug=yongpyong&key=YOUR_MAPS_KEY"
```

Standalone HTML (Cesium JS + Google Photorealistic 3D Tiles). Loads
any `<slug>.slope-graph.json` from the registry and draws nodes +
edges over real 3D terrain. Slopes are coloured by difficulty, lifts
yellow-dashed. Click an edge (or pick from the sidebar) for details.
The Maps API key needs the **Map Tiles API** enabled and is cached
in localStorage on your browser only. Set `?data_base=` to point at
a non-GitHub mirror if needed.
