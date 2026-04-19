# Contributing

This repository is meant for pull-request-based community updates to ski reference data.

## Contribution Rules

- prefer official resort, operator, or tourism-board sources when available
- preserve stable slugs once published
- keep one factual topic per pull request where practical
- include source links in the pull request description for factual changes
- avoid mixing unrelated countries or regions in one pull request
- do not commit secrets, private endpoints, or copyrighted map data without permission

## Path Rules

- places live at `registry/<country>/<region>/<place>.json`
- slopes live at `registry/<country>/<region>/<place>.slopes.json`
- lifts live at `registry/<country>/<region>/<place>.lifts.json`
- webcams live at `registry/<country>/<region>/<place>.webcams.json`
- ski domains live at `registry/ski-domains/<slug>.json`

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
