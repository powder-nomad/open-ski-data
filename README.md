# Open Ski Data

Canonical ski place reference data for apps, APIs, and public websites.

This repository is intended to become a contributor-maintained public data source for ski areas around the world. It stores mostly static or slow-changing facts such as place identity, geography, terrain metadata, lift metadata, webcams, and ski-domain groupings.

## Quick links

| You want to… | Go here |
|---|---|
| **Fix a resort right now** (no clone, no PR) | **<https://osd-edit.pages.dev>** — sign in with GitHub, click. |
| Understand the whole project | [docs/REPO-OVERVIEW.md](./docs/REPO-OVERVIEW.md) |
| Use the data in an app | [Raw Usage](#raw-usage) below + [docs/SCHEMAS.md](./docs/SCHEMAS.md) |
| Contribute via pull request | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| Tour the web editor | [docs/EDITOR-GUIDE.md](./docs/EDITOR-GUIDE.md) |
| Hack on the editor itself | [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) + `git checkout pages` |
| Rename a slug | [docs/SLUG-LIFECYCLE.md](./docs/SLUG-LIFECYCLE.md) |

> **Two branches:** `main` (this branch) holds data + schemas; `pages`
> holds the web editor. They are **orphan** branches with no shared
> history — don't try to merge them. See
> [docs/REPO-OVERVIEW.md](./docs/REPO-OVERVIEW.md) for the layout.

## License & Attribution

Dual-license:

- **Data** (`registry/`, `schemas/`) — [ODbL-1.0](./LICENSE-DATA)
- **Code** (`scripts/`, validators, app code) — [MIT](./LICENSE-CODE)

A substantial portion of `registry/` is derived from OpenStreetMap.
Any public use or redistribution must preserve the OSM attribution
detailed in [NOTICE](./NOTICE):

> Contains data from OpenStreetMap, © OpenStreetMap contributors,
> available under the Open Database License (ODbL).

Apps and APIs built on top of this data are "Produced Works" under
ODbL §2 — they may be released under any license (including
proprietary or commercial), provided the attribution above appears
somewhere visible to end users (footer, about screen, credits page).

## Purpose

- keep ski reference data separate from product code and user-generated data
- publish stable JSON paths that other projects can consume directly
- make factual corrections and additions easy to review through pull requests
- support a world-ready structure without forcing clients to download one giant flat index

## Repository Layout

Every resort lives in its own subdirectory at `<country>/<region>/<slug>/`, with all of its files inside:

```text
registry/
  index.json
  kr/
    index.json
    gangwon/
      index.json
      yongpyong/
        place.json
        slopes.json
        lifts.json
        webcams.json
        slope-graph.json
      alpensia/
        place.json
        slopes.json
        lifts.json
        webcams.json
        slope-graph.json
  jp/
    index.json
    hokkaido/
      index.json
      niseko-grand-hirafu/
        place.json
        slopes.json
        lifts.json
        webcams.json
  ski-domains/
    index.json
    niseko-united.json
  live/
schemas/
scripts/
  check-reference-data.mjs
  import-skiwatch.mjs
```

Rationale: a region can contain 10+ resorts, and with the previous flat layout (`alpensia.json`, `alpensia.slopes.json`, `alpensia.lifts.json`, `alpensia.webcams.json`, `alpensia.slope-graph.json`, then repeat for each other resort) the region folder became 50+ siblings and was hard to navigate. Nesting per resort keeps each resort's files grouped and makes contributor PRs easier to scope to one resort.

## Data Model

Core geography:

- `country`
- `region`
- `place`

Cross-place grouping:

- `ski_domain`

Use `place` for the local resort identity.
Use `ski_domain` for interconnected multi-resort areas such as Niseko United or other linked domains.

## Index Strategy

The repository uses hierarchical indexes as the primary source of truth.

- `registry/index.json` lists countries
- `registry/<country>/index.json` lists regions
- `registry/<country>/<region>/index.json` lists places in that region — each entry's `path` points at `registry/<country>/<region>/<slug>/place.json`
- the canonical place record is `registry/<country>/<region>/<slug>/place.json`; its siblings (`slopes.json`, `lifts.json`, `webcams.json`, `slope-graph.json`) carry the detailed datasets for that resort
- `registry/ski-domains/index.json` lists ski domains

This keeps browsing payloads small, makes pull requests more localized, and avoids one giant global routing file becoming a merge-conflict hotspot.

## Data Categories

Current categories:

- place records
- slope records
- lift records
- webcam records
- ski-domain records

Planned future categories:

- lift ticket pricing
- season pass products
- operating dates and hours
- terrain parks and named features
- parking, shuttle, and village metadata
- geospatial trail geometry and merge or diverge points
- lift terminal coordinates and altitude
- official source links and per-field verification timestamps

## Validation

Run the repository validators locally:

```bash
npm run check:reference-data   # JSON sanity + schema validation + index integrity
npm run check:stable-ids       # slope/lift id stability across renames
npm run check:aliases          # aliases ledger well-formedness
npm run check:provenance       # provenance coverage (warn mode)
```

The same scripts run in CI on every push and PR to `main`. See
[docs/ARCHITECTURE.md#ci](./docs/ARCHITECTURE.md#ci) for what CI
does on each branch.

## Raw Usage

Example path patterns:

```text
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/index.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/index.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/index.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/yongpyong/place.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/yongpyong/slopes.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/yongpyong/lifts.json
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/yongpyong/webcams.json
```

## Relationship to OpenStreetMap

open-ski-data is a curated **supplement** to OpenStreetMap's ski
coverage, not a replacement.

What we add on top of OSM:

- operator-curated metadata (homepages, official names, season
  passes, ticket products) that doesn't belong in OSM
- single-fetch composite JSON paths so downstream apps don't have to
  query Overpass on every page load
- per-vertex DEM-sampled elevations on slopes and lifts (OSM nodes
  don't carry altitude)
- explicit junction nodes (`slope-graph.json`) for routing /
  trail-snap use cases
- multilingual display names cascaded `name:ko` / `name:en` / `name:ja`
- stable, slug-keyed identifiers consumers can cache (`places.slug`
  in Ridgecast, `/resorts/<slug>` URLs in SkiWatch)

Why this reduces load on OSM:

- consumers fetch from `raw.githubusercontent.com` (a CDN) instead
  of `overpass-api.de` (a community-funded query backend)
- composite JSON bundles per resort mean one HTTP request instead
  of multiple Overpass queries
- our import pipeline (`scripts/import_resort.py`) runs Overpass on
  human cadence (when a resort is added or refreshed), not per app
  request

We periodically re-sync from OSM via the import pipeline and merge
operator-curated overrides on top.

## Provenance & Sources

Records in this repository carry an optional `provenance` field
identifying where the data originated:

- **OpenStreetMap** — fetched via Overpass, written by the import
  pipeline at `scripts/import_resort.py` (slope geometry, lift
  endpoints, base topology)
- **Operator** — official resort, lift company, or tourism board
  publications (homepages, season passes, ticket products,
  curated trail names)
- **User edit** — corrections submitted via pull request through
  the planned web editor
- **Imports** — seed data originally migrated from
  `paulkim-xr/SkiWatch` and `ski-platform/packages/reference-data`

See [NOTICE](./NOTICE) for the full attribution policy and
`schemas/place.schema.json` for the `provenance` field shape.

## Documentation

The full doc set lives under [`docs/`](./docs/):

- [REPO-OVERVIEW.md](./docs/REPO-OVERVIEW.md) — branches, directory map, contribution lifecycle, external dependencies
- [EDITOR-GUIDE.md](./docs/EDITOR-GUIDE.md) — contributor-facing tour of the web editor at <https://osd-edit.pages.dev>
- [SCHEMAS.md](./docs/SCHEMAS.md) — entity-by-entity field reference for everything in `registry/`
- [ARCHITECTURE.md](./docs/ARCHITECTURE.md) — engineer-facing stack overview, save flow, OAuth handshake, CI, deploy
- [SLUG-LIFECYCLE.md](./docs/SLUG-LIFECYCLE.md) — slug rename rules + the aliases ledger
- [CONTRIBUTING.md](./CONTRIBUTING.md) — contribution rules, provenance conventions, path rules
