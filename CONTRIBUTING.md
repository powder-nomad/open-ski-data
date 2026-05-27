# Contributing

This repository is meant for pull-request-based community updates to ski reference data.

## Contribution Rules

- prefer official resort, operator, or tourism-board sources when available
- preserve stable slugs once published
- keep one factual topic per pull request where practical
- include source links in the pull request description for factual changes
- avoid mixing unrelated countries or regions in one pull request
- do not commit secrets, private endpoints, or copyrighted map data without permission
- by submitting a PR, you license your contribution under ODbL-1.0 (data) and MIT (code) — the same licenses the repository uses; see [LICENSE](./LICENSE)

## Provenance

Every factual change should be traceable to a source. Records carry
an optional `provenance` field that captures this — when adding or
editing data, set or update it so downstream consumers and future
reviewers can audit the trail.

The field shape (see `schemas/place.schema.json` for the full
definition):

```jsonc
{
  "provenance": {
    "source": "osm",           // or "operator", "user-edit", "import"
    "osm_way_id": 1234567,     // when source = "osm"
    "osm_version": 12,         //   ^
    "contributor": "...",      // OSM mapper handle or GitHub username
    "source_url": "...",       // official page, news article, etc.
    "last_verified": "2026-05-27"
  }
}
```

Rules of thumb:

- when *importing* from OpenStreetMap: set `source: "osm"` plus the
  `osm_way_id` / `osm_version` (the import pipeline does this
  automatically)
- when *adding* a fact from an official source (resort homepage,
  press release, tourism board): set `source: "operator"` and fill
  `source_url`
- when *confirming* an existing fact is still accurate (e.g., you
  visited the resort and verified the lift count): update
  `last_verified` and add yourself as `contributor`
- when *correcting* an OSM-derived fact based on local knowledge:
  change `source` from `"osm"` to `"user-edit"`, add yourself as
  `contributor`, and document the correction reason in the PR
  description

The `provenance` field is currently **optional** to keep the bar low
for early contributions, but new records added through the
forthcoming web editor will populate it automatically.

## Path Rules

Every resort is a subdirectory under its region: `registry/<country>/<region>/<place>/`. Inside that directory:

- place record: `place.json`
- slopes: `slopes.json`
- lifts: `lifts.json`
- webcams: `webcams.json`
- slope graph (derived): `slope-graph.json`

Ski domains live outside the country hierarchy at `registry/ski-domains/<slug>.json`.

Keep the file path aligned with the record identifiers:

- `country_code`
- `region_slug`
- `place_slug`

## Review Expectations

Reviewers should check:

- factual plausibility
- schema conformance
- stable IDs and slugs
- path naming consistency
- index updates for any new country, region, or place
- source provenance in the pull request description

## Good Contribution Scope

- one place
- one region
- one ski domain
- one factual correction set

## Good Future Contributions

- corrected coordinates
- missing lifts or runs
- new webcams
- renamed or retired trails
- updated summit and base elevations
- pass products and lift ticket data
- official operating dates
- geospatial trail and lift shape data
- multilingual display names
- source verification timestamps
