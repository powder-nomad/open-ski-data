# Schema reference

Every JSON file in `registry/` validates against a JSON Schema in
`schemas/`. This doc lists each schema, its required fields, and
the patterns reviewers actually care about. The schemas themselves
are authoritative — if this doc and the schemas disagree, the
schemas win.

The canonical entry points:

- `registry/index.json` → `schemas/registry-index.schema.json`
- `registry/<cc>/index.json` → `schemas/country-index.schema.json`
- `registry/<cc>/<region>/index.json` → `schemas/region-index.schema.json`
- `registry/<cc>/<region>/<slug>/place.json` → `schemas/place.schema.json`
- `registry/<cc>/<region>/<slug>/slopes.json` → `schemas/slope.schema.json`
- `registry/<cc>/<region>/<slug>/lifts.json` → `schemas/lift.schema.json`
- `registry/<cc>/<region>/<slug>/webcams.json` → `schemas/webcam.schema.json`
- `registry/<cc>/<region>/<slug>/slope-graph.json` → `schemas/slope-graph.schema.json`
- `registry/ski-domains/<slug>.json` → `schemas/ski-domain.schema.json`
- `registry/aliases.json` → `schemas/aliases.schema.json`

Live conditions data is consumed (not stored) by the registry:

- conditions feeds → `schemas/conditions.schema.json`

In every schema below, `*` marks required fields and the type
shorthand mirrors the JSON Schema: `string`, `number`, `integer`,
`boolean`, `array`, `object`, `null`, or `enum[...]`. Patterns like
`^[a-z0-9-]+$` are slug constraints; everything is kebab-case
lowercase.

## Slug constraints (used everywhere)

```text
country_code  : ^[a-z]{2}$            two-letter ISO 3166-1 alpha-2
region_slug   : ^[a-z0-9-]+$          kebab-case
place_slug    : ^[a-z0-9-]+$          kebab-case
```

Slugs are stable once published. To rename one, see
[SLUG-LIFECYCLE.md](./SLUG-LIFECYCLE.md).

## place.json

The canonical record for a resort. One file per resort.

```text
* country_code      : string (^[a-z]{2}$)
* region_slug       : string (^[a-z0-9-]+$)
* place_slug        : string (^[a-z0-9-]+$)
* name              : string — canonical English name
  name_i18n         : object<lang, string> — e.g. {"ko": "용평", "en": "Yongpyong"}
  region            : string — display name (English)
  region_i18n       : object<lang, string>
  country           : string — display name (English)
  country_i18n      : object<lang, string>
* coordinates       :
    * latitude      : number
    * longitude     : number
  elevations        :
    base_m          : integer
    summit_m        : integer
  tags              : array<string>
  homepage          : string (URI)
  air_korea_station : string — KR-only AQI station code
  provenance        : provenance object (see below)
```

Locale keys in `name_i18n` / `region_i18n` / `country_i18n` are
ISO 639-1 (`ko`, `en`, `ja`, …). The bare `name` is the fallback
when a consumer asks for a locale not in the map.

## slopes.json

Catalog of every run / trail on the mountain.

```text
* country_code  : string
* region_slug   : string
* place_slug    : string
* slopes        : array of:
    * id        : string | integer — stable identifier
    * name      : string
      name_i18n : object<lang, string>
      type      : enum[run, lift, access_route]
      difficulty: enum (unified international band — see below)
      length_m  : number | null
      width_m   : number | null
      area_m2   : number | null
      elevation_m: number | null
      min_angle_deg : number | null
      avg_angle_deg : number | null
      max_angle_deg : number | null
      connected_slope_ids : array<id>
      connected_lift_ids  : array<id>
      coordinates : array of { lat: number, lon: number }
      provenance  : provenance object
```

The **`difficulty`** band is internationally unified — KR resorts'
초급/중급/상급 labels map onto the same enum North American resorts
use (green / blue / black / double-black). Consumers translate to
local labelling at render time:

```text
super_beginner       (bunny hill, KR 초보)
beginner             (NA green, KR 초급)
beginner_intermediate(stepping-stone, KR 초중급)
intermediate         (NA blue,  KR 중급)
intermediate_advanced(stepping-stone, KR 중상급)
advanced             (NA single black, KR 상급)
advanced_expert      (stepping-stone)
expert               (NA double black, KR 최상급)
```

`coordinates` is the slope's polyline geometry. Each vertex is
`{lat, lon}`; altitudes live on the routing graph (see
`slope-graph.json`) instead of being duplicated here.

`connected_slope_ids` / `connected_lift_ids` carry the human-authored
connectivity model from SkiWatch — useful for "which lifts serve
this run?" without re-walking the routing graph.

## lifts.json

Catalog of every lift, gondola, magic carpet.

```text
* country_code  : string
* region_slug   : string
* place_slug    : string
* lifts         : array of:
    * id        : string | integer
    * name      : string
      name_i18n : object<lang, string>
      type      : string — open-ended (chair, gondola, magic_carpet, t-bar, …)
      capacity_per_hour : integer | null
      length_m  : number | null
      vertical_m: number | null
      connected_slope_ids : array<id>
      connected_lift_ids  : array<id>
      coordinates : array of:
        * lat   : number
        * lon   : number
          alt_m : number | null
      provenance : provenance object
```

Lift `coordinates` carry per-vertex altitudes because lifts often
have only two real vertices (bottom + top); the altitude on each
is meaningful even without a full routing graph.

## webcams.json

Webcam metadata. URLs only — the registry never proxies stream
contents.

```text
* country_code   : string
* region_slug    : string
* place_slug     : string
* webcams        : array of:
    * label      : string
      label_i18n : object<lang, string>
    * url        : string (URI)
    * type       : enum[image, stream, hls, iframe, external, unavailable, vivaldi]
      refresh_interval_ms : integer
      coordinates :
        * lat    : number
        * lon    : number
          label  : string
      provenance : provenance object
```

`unavailable` is a real type — use it for webcams that exist in
operator messaging but have no working URL we can ship. That way
the registry can still attribute the camera without breaking
clients that expect to render it.

## slope-graph.json

Optional but recommended. An explicit node-and-edge representation
of the resort's slope + lift network, purpose-built for GPS
map-matching.

```text
  $schema       : string
* place_slug    : string (^[a-z0-9-]+$, matches sibling place.json)
* version       : integer (≥ 1)
* nodes         : array (≥ 2 items), of:
    * id        : string (^n-[a-z0-9-]+$)
    * lat       : number
    * lng       : number
    * alt_m     : number  — required; algorithm uses it
      kind      : enum[summit, base, fork, merge, lift_top, lift_bottom, lift_station, waypoint]
      notes     : string  — author commentary, never read by the algorithm
* edges         : array (≥ 1 item), of:
    * id        : string (^e-[a-z0-9-]+$)
    * kind      : enum[slope, lift, traverse]
    * from      : string (node id, upstream end)
    * to        : string (node id, downstream end)
    * geometry  : array of:
        * lat   : number
        * lng   : number
        * alt_m : number  — required per-vertex
      slope_id  : string | null — links back to slopes.json[*].id
      difficulty: enum (same as slope.difficulty)
      length_m  : number — along-polyline; authored or computed
      notes     : string
  snap_config   :
      r_max_m       : number — candidate-edge radius around each GPS sample
      sigma_z_m     : number — emission Gaussian sigma
      gap_bridge_s  : number — max GPS gap bridgeable without breaking a run
      conf_floor    : number — runs below this confidence are emitted unsnapped
```

Node `kind` is **advisory** — it labels the topology for human
readers. The map-matching algorithm only looks at node degree
(how many edges touch the node) to detect forks and merges.
`lift_station` flags an intermediate stop on a multi-stage lift
where skiers can board / exit; author such lifts as a chain like
`lift_bottom → lift_station → lift_top`, which is two `kind: lift`
edges.

Edge `kind`:

- `slope` — downhill terrain that counts as a run
- `lift` — uphill transport; cuts runs in the topology
- `traverse` — access road / cat track; part of the graph but not
  a counted run

Geometry vertices must include altitudes. The first and last
vertices have to match the `from` / `to` node coordinates exactly
(the editor enforces this via auto-snap on draw).

## ski-domain.json (and ski-domains/index.json)

Multi-resort domains — Niseko United, Whistler-Blackcomb,
Trois Vallées-style interconnects.

```text
* country_code      : string
* region_slug       : string
* slug              : string (^[a-z0-9-]+$)
* name              : string
  region            : string
  country           : string
* member_place_slugs: array<string> (kebab-case slugs of member resorts)
  tags              : array<string>
```

Use a `ski_domain` when several places share lift tickets or a
connected mountain. Use just `place` records when the resort is
standalone.

## registry-index.json (and country-index.json, region-index.json)

The hierarchical indexes that let consumers discover resorts
without one giant flat file.

`registry-index.json`:

```text
* countries : array of:
    * country_code : string (ISO 3166-1 alpha-2)
    * name         : string
      default_language : string (ISO 639-1)
    * path         : string — e.g. "registry/kr/index.json"
```

Country index (`registry/<cc>/index.json`):

```text
* country  : { country_code, name, default_language }
* regions  : array of:
    * region_slug : string
    * name        : string
    * path        : string — e.g. "registry/kr/gangwon/index.json"
```

Region index (`registry/<cc>/<region>/index.json`):

```text
* country : { country_code }
* region  : { region_slug, name }
* places  : array of:
    * place_slug : string
    * path       : string — e.g. "registry/kr/gangwon/alpensia/place.json"
```

Adding a new resort means adding entries to (at minimum) the
region index. Adding a new country adds a country index + an
entry on the registry index.

## aliases.json

The slug rename ledger. Append-only — once an entry ships, never
delete or edit it; downstream consumers reconcile against the
ledger to handle redirects.

```text
* renames : array of:
    * from : string (^[a-z0-9][a-z0-9-]*$) — legacy slug
    * to   : string (^[a-z0-9][a-z0-9-]*$) — canonical slug
    * at   : string (date, YYYY-MM-DD) — when the rename was first published
```

See [SLUG-LIFECYCLE.md](./SLUG-LIFECYCLE.md) for when to add an
entry vs. force-rename without a ledger entry.

## conditions.schema.json

Live dynamic data — snowfall, temperature, status. The registry
does **not** store this; the schema lives here so home servers and
condition feeds validate against a stable shape.

```text
* slug             : string
* last_updated     : string (date-time, ISO 8601)
* snowfall_24h_cm  : number
  snowfall_7d_cm   : number
  temperature_c    : number
  wind_kph         : number
* status           : enum[open, closed, hold, limited]
  source_debug     : object — arbitrary key/value debug payload
```

## Provenance (shared sub-schema)

Every record can carry a `provenance` block. Optional today; the
web editor populates it automatically.

```text
provenance:
  * source         : enum[osm, operator, user-edit, import]
    osm_way_id     : integer       — when source = "osm"
    osm_node_ids   : array<integer>
    osm_version    : integer       — when source = "osm"
    contributor    : string        — OSM mapper handle or GitHub username
    source_url     : string (URI)  — official page / press release / etc.
    last_verified  : string (date) — YYYY-MM-DD
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for source-specific
rules of thumb (when to use `osm` vs `operator` vs `user-edit`).
