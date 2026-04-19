# Open Ski Data

Canonical ski place reference data for apps, APIs, and public websites.

This repository is intended to become a contributor-maintained public data source for ski areas around the world. It stores mostly static or slow-changing facts such as place identity, geography, terrain metadata, lift metadata, webcams, and ski-domain groupings.

## Purpose

- keep ski reference data separate from product code and user-generated data
- publish stable JSON paths that other projects can consume directly
- make factual corrections and additions easy to review through pull requests
- support a world-ready structure without forcing clients to download one giant flat index

## Repository Layout

```text
registry/
  index.json
  kr/
    index.json
    gangwon/
      index.json
      yongpyong.json
      yongpyong.slopes.json
      yongpyong.lifts.json
      yongpyong.webcams.json
  jp/
    index.json
    hokkaido/
      index.json
      niseko-grand-hirafu.json
  ski-domains/
    index.json
    niseko-united.json
  live/
schemas/
scripts/
  check-reference-data.mjs
  import-skiwatch.mjs
```

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
- `registry/<country>/<region>/index.json` lists places in that region
- canonical place files live under their country and region path
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
https://raw.githubusercontent.com/<owner>/open-ski-data/<branch>/registry/kr/gangwon/yongpyong.json
```

## Seed Provenance

Initial records are derived from:

- `paulkim-xr/SkiWatch`
- `ski-platform/packages/reference-data`

The repository should evolve beyond those seeds over time, but the initial provenance remains relevant for auditing and migration history.
