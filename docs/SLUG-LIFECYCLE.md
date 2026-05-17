# Slug lifecycle

Slugs (`place_slug` in `place.json`, also the directory name under
`registry/<country>/<region>/`) are this repo's stable identifiers.
Downstream consumers — Ridgecast (stores `places.slug`), SkiWatch
(URL routes `/resorts/:slug`), Snowple, anyone else hitting the
CDN — key off these.

Once a slug ships in a release, you generally can't change it
without breaking those consumers. This doc spells out the two
sanctioned ways to change one anyway.

## TL;DR

| Situation | Use |
|---|---|
| You typed a slug, opened a PR, nobody else has touched it yet | **Force-rename** — edit the dir + `place_slug`, push. Done. |
| The slug shipped in `main` and consumers may have already cached it | **Aliased rename** — append to `registry/aliases.json`, then change `place_slug`. |

The aliases.json validator (`scripts/check-aliases.mjs`) doesn't
care which path you take — it only checks that whatever you put in
the ledger is well-formed. Force-renames simply skip the ledger.

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

## Path 2 — Aliased rename (with ledger)

Use when the slug has been published widely.

1. **Append the rename entry first** to `registry/aliases.json`:

   ```jsonc
   {
     "renames": [
       { "from": "old-slug", "to": "new-slug", "at": "2026-05-17" }
     ]
   }
   ```

2. **Then rename the directory** and update `place_slug`:

   ```bash
   git mv registry/<country>/<region>/<old-slug> \
          registry/<country>/<region>/<new-slug>
   # Edit place.json's place_slug field
   ```

3. **Commit both changes in the same PR** so consumers see the
   intent and the data together.

4. The aliases validator confirms structural validity in CI.

### What downstream consumers do

- **Ridgecast** runs `refresh_registry_aliases()` daily. For each
  ledger entry where `from` still exists in `places.slug`, it runs
  `UPDATE places SET slug = to WHERE slug = from`. Idempotent —
  safe to repeat.
- **SkiWatch** can build the aliases into its 404 handler: on
  `/resorts/<unknown>`, look up the slug in aliases, 301 to the
  canonical URL. Or it can preemptively rewrite its registry at
  build time using the ledger.
- **New consumers**: pull aliases.json at startup, build an
  in-memory map, redirect any incoming reference to the canonical
  slug.

## Append-only rule

Never edit or remove an existing aliases entry. The ledger is the
authoritative history downstream consumers depend on. If a rename
turned out to be wrong, append a *new* entry reversing it
(`from: new-slug, to: original`); the validator forbids the same
`from` appearing twice, so this scheme also forbids "renaming a
renamed slug" — you'd have to rename via the latest canonical.

## What about non-slug field changes?

Out of scope for this doc. `place_slug` and the directory name are
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
