# Slug lifecycle

Slugs (`place_slug` in `place.json`, also the directory name under
`registry/<country>/<region>/`) are this repo's stable identifiers.
Downstream consumers — Ridgecast (stores `places.slug`), SkiWatch
(URL routes `/resorts/:slug`), Snowple, anyone else hitting the
CDN — key off these.

The same lifecycle rules apply to **per-place item identifiers** —
`slope.id`, `lift.id`, `webcam.label`. Snowple addresses a lift
status as the composite key `<place_slug>.<lift.id>` (eg.
`high1.gondola-express`); changing either component breaks the
join.

Once any of these identifiers ships in a release, you generally
can't change it without breaking consumers. This doc spells out the
two sanctioned ways to change one anyway.

## TL;DR

| Situation | Use |
|---|---|
| You typed a slug/id, opened a PR, nobody else has touched it yet | **Force-rename** — edit the dir/JSON, push. Done. |
| A `place_slug` shipped in `main` and consumers may have cached it | **Aliased place rename** — append to `aliases.json#/renames`, then change `place_slug`. |
| A `slope.id` / `lift.id` / `webcam.label` shipped in `main` and consumers may have cached it | **Aliased item rename** — append to `aliases.json#/items`, then change the id in the sidecar. |

The aliases.json validator (`scripts/check-aliases.mjs`) doesn't
care which path you take — it only checks that whatever you put in
the ledger is well-formed. Force-renames simply skip the ledger.

The stable-id guard (`scripts/check-stable-ids.mjs`) consults
`aliases.json` to reconcile expected renames against the base ref
diff — append the ledger entry in the same PR as the rename and the
guard treats it as acknowledged rather than drift.

## Decision rule

"Has anyone in the field had a chance to cache the bad slug?"

- **No** (PR still open, slug never on `main`, less than a few
  hours since merge with no known consumer pull) → force-rename.
- **Yes** (slug has been on `main` for a release cycle; you've seen
  Ridgecast write a `places` row with that slug; SkiWatch may have
  a deployed build with that URL) → aliased rename.

If you're unsure, use the aliased rename — it has near-zero cost
and saves consumers an unexplained 404.

## Path 1 — Force-rename (no ledger)

Use when the wrong slug never spread.

```bash
# Example: `furrano` typo → `furano`
cd registry/jp/hokkaido
git mv furrano furano
# Edit registry/jp/hokkaido/furano/place.json:
#   "place_slug": "furrano"  ->  "place_slug": "furano"
# Also fix any reference to it in this repo (sibling files, README).
npm run check:reference-data
git commit -am 'fix(slug): correct furrano typo to furano'
```

No `aliases.json` change. Downstream consumers will re-sync from
`registry/index.json` on their next cycle and pick up the new
canonical slug. Any rows / cached entries under the old slug
become orphans — operator-side cleanup if they made it that far,
which by definition they didn't here.

## Path 2 — Aliased place rename (with ledger)

Use when the `place_slug` has been published widely.

1. **Append the rename entry first** to `registry/aliases.json`,
   under the `renames` array. The `seq` field is a strictly
   increasing positive integer starting at 1 — pick the next value
   after the last entry. The two arrays in this file have
   independent seq spaces.

   ```jsonc
   {
     "renames": [
       { "seq": 1, "from": "old-slug", "to": "new-slug", "at": "2026-05-17" }
     ],
     "items": []
   }
   ```

2. **Then rename the directory** and update `place_slug`:

   ```bash
   git mv registry/<country>/<region>/<old-slug> \
          registry/<country>/<region>/<new-slug>
   # Edit place.json's place_slug field
   ```

3. **Commit both changes in the same PR** so consumers see the
   intent and the data together. `check-stable-ids.mjs` rewrites
   every `slope:/lift:/webcam:` id under the old slug to the new
   one before diffing, so no `allow-id-change` label is needed.

4. The aliases validator confirms structural validity in CI.

### What downstream consumers do

- **Ridgecast** runs `refresh_registry_aliases()` daily. For each
  `renames` entry where `from` still exists in `places.slug`, it
  runs `UPDATE places SET slug = to WHERE slug = from`. Idempotent
  — safe to repeat.
- **SkiWatch** can build the aliases into its 404 handler: on
  `/resorts/<unknown>`, look up the slug in aliases, 301 to the
  canonical URL. Or it can preemptively rewrite its registry at
  build time using the ledger.
- **New consumers**: pull aliases.json at startup, build an
  in-memory map, redirect any incoming reference to the canonical
  slug.

### Incremental cursors

Both `renames` and `items` entries carry a `seq` integer that is
strictly monotonic within its array. Consumers that have already
ingested up to seq `N` can stream only entries with `seq > N` on
their next sync — no need to re-read or re-process the whole
ledger. The two arrays have independent cursor spaces, so a
consumer that only cares about place renames can ignore the
`items` cursor entirely.

## Path 3 — Aliased item rename (with ledger)

Use when a `slope.id` / `lift.id` / `webcam.label` has been
published widely and renaming it directly would orphan downstream
rows.

1. **Append the rename entry first** to `aliases.json#/items`.
   Each entry binds the rename to a specific `place_slug` so the
   same `from` id can be reused across resorts without ambiguity
   (eg. two resorts both having a `bunny` slope is fine — the
   composite `<place_slug>.<id>` key already disambiguates them).

   ```jsonc
   {
     "renames": [],
     "items": [
       {
         "seq": 1,
         "kind": "lift",
         "place_slug": "high1",
         "from": "g1",
         "to": "gondola-express",
         "at": "2026-06-16"
       }
     ]
   }
   ```

   - `kind` is one of `"lift"`, `"slope"`, `"webcam"`.
   - `place_slug` is the **current** slug — if the place is also
     being renamed in the same PR, use the post-rename slug here
     and add the `renames` entry alongside it.
   - For `webcam`, `from`/`to` are `label` values (webcams have no
     id field).

2. **Then update the id in the sidecar** (`slopes.json` /
   `lifts.json` / `webcams.json`) and any `connected_lift_ids` /
   `connected_slope_ids` references that pointed at the old id.

3. **Commit both changes in the same PR.** `check-stable-ids.mjs`
   sees the ledger entry, rewrites the base side from old → new,
   and reports the rename as acknowledged.

4. The aliases validator confirms structural validity in CI.

### Item-id uniqueness within a file

`check-reference-data.mjs` rejects duplicate `id` values within a
single `slopes.json` / `lifts.json` and duplicate `label` values
within a single `webcams.json`. The composite-slug rules already
handle cross-resort collisions (eg. two resorts both having a
`bunny` slope is fine — they live under different `place_slug`s),
so the validator only checks in-file uniqueness.

## Append-only rule

Never edit or remove an existing aliases entry. The ledger is the
authoritative history downstream consumers depend on. If a rename
turned out to be wrong, append a *new* entry reversing it
(`from: new-slug, to: original`); the validator forbids the same
`from` appearing twice in `renames`, and forbids the same
`(place_slug, kind, from)` tuple appearing twice in `items`. So
this scheme also forbids "renaming a renamed identifier" — you'd
have to chain the next rename via the latest canonical.

## What about non-slug field changes?

Out of scope for this doc. `place_slug`, the directory name, and
the item identifiers (`slope.id`, `lift.id`, `webcam.label`) are
the only fields treated as identifiers; rename anything else freely.

## Atomicity across services

The system is **eventually consistent** by design. There's no
synchronous lock that pauses Ridgecast while open-ski-data is
mid-rename. Instead:

- Consumers sync from the CDN periodically.
- Within one sync window after a ledger entry lands, all consumers
  agree on the canonical slug.
- Force-renames carry a slightly longer inconsistency window (the
  old slug → 404 until the next sync). That's the trade-off you
  pick by skipping the ledger.

If you ever need strict cross-service atomicity (e.g. switching a
slug at a known release boundary), coordinate the deploy windows
manually — the system doesn't enforce it.
