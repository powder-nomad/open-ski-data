# Open Ski Data

Canonical ski place reference data for apps, APIs, and public websites.

This repository is intended to become a contributor-maintained public data source for ski areas around the world. It stores mostly static or slow-changing facts such as place identity, geography, terrain metadata, lift metadata, webcams, and ski-domain groupings.

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

Run the repository validator locally:

```bash
node scripts/check-reference-data.mjs
```

The validator checks JSON sanity, hierarchical path consistency, index integrity, and ski-domain membership references.

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

## Seed Provenance

Initial records are derived from:

- `paulkim-xr/SkiWatch`
- `ski-platform/packages/reference-data`

The repository should evolve beyond those seeds over time, but the initial provenance remains relevant for auditing and migration history.
