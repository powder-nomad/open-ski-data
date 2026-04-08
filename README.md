# Ski Reference Data

Canonical ski resort reference data for use by apps, APIs, and public websites.

This repository is intended to become a contributor-maintained data source for ski places around the world. The initial seed is based on data already curated in `paulkim-xr/SkiWatch`, then reorganized into a JSON-first layout designed for direct use from `raw.githubusercontent.com`.

## Goals

- keep mostly static ski-domain facts in one place
- separate reference data from user-generated product data
- make records easy to review and update through pull requests
- publish stable JSON paths that other projects can consume directly

## Repository Layout

```text
registry/
  index.json
  places/
  slopes/
  lifts/
  webcams/
  live/
schemas/
  place.schema.json
  slope.schema.json
  lift.schema.json
  webcam.schema.json
scripts/
  import-skiwatch.mjs
```

## Data Model Direction

Current categories:

- `places`
  Resort-level identity, names, coordinates, tags, links, and summary counts
- `slopes`
  Run and terrain records such as difficulty, length, width, area, angle, and connected lift or slope IDs
- `lifts`
  Lift records such as length, seat count, cabin count, speed, ride time, capacity, and connections
- `webcams`
  Public camera and stream endpoints
- `live`
  Placeholder area for data that changes more often than pure reference records

Planned future categories:

- pass products and lift-ticket pricing
- operating seasons and opening windows
- terrain parks and named features
- base village and parking metadata
- geospatial trail geometry and merge or diverge points
- lift terminals with lat/lng and altitude
- resort contact info and official policy links
- snowmaking coverage and night-ski availability
- accessibility and family-service metadata
- source provenance and last-verified timestamps per field

## Raw Usage

Example path pattern:

```text
https://raw.githubusercontent.com/<owner>/ski-reference-data/<branch>/registry/places/konjiam.json
```

Repository-wide index:

```text
https://raw.githubusercontent.com/<owner>/ski-reference-data/<branch>/registry/index.json
```

## Seed Provenance

Initial records are derived from:

- `paulkim-xr/SkiWatch`
- the local `ski-platform/packages/reference-data` registry derived from that source

The repository should evolve beyond SkiWatch over time, but the initial dataset keeps that provenance explicit.
