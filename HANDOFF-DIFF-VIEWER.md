# Handoff — visual PR diff viewer

> Branch: **`pages`** (orphan, deploys to <https://osd-edit.pages.dev>)
> Recipient: agent that has previously shipped on this branch
> Author of handoff: Claude (Opus 4.7) on 2026-06-30
> Status: spec only — implementation not started

## Why this exists

Paul (owner) cannot validate data PRs against `main` by reading JSON.
For graph cleanup PRs like
[#2 (`cleanup/alpensia-dedupe-orphans`)](https://github.com/powder-nomad/open-ski-data/pull/2)
the raw diff is opaque: removing 6 dup edges and 1 orphan node looks
identical in JSON to removing 6 *real* edges and an *important* node.
The fix proposed and approved on Discord:

> a `/diff` route on `osd-edit.pages.dev` that takes a PR number (or
> base/head SHAs), fetches both blobs from GitHub, and renders the
> graph delta on the live map so the reviewer can eyeball intent
> before merging.

PR #2 is the worked example throughout this doc. It's already merged?
Check `gh pr view 2 --repo powder-nomad/open-ski-data --json state`.
If still open, use it as the smoke-test target. If merged, use the
merge commit's parents as `base` / `head` for the smoke test.

## URL contract

Two query-string shapes, same handler:

```
https://osd-edit.pages.dev/diff?pr=2
https://osd-edit.pages.dev/diff?base=<sha>&head=<sha>
```

The `pr=N` form resolves to base/head SHAs via the GitHub API at page
load. The `base/head` form is what shows up in PR body links — stable
even after force-push or rebase. Generate both; prefer `base/head` in
the auto-comment, keep `pr=N` for humans who paste a number.

## Visual design

Reuse the editor's glass aesthetic (already converged on rounds
002–005, score ≥4 on all six rubric axes). Do not re-litigate the
shell.

- **Map**: `fixed inset-0`, full viewport canvas. Same Google Maps
  loader as `src/app/editor/editor.tsx` (port 3017 lock applies —
  Maps API key is allowlisted only to localhost:3017 for dev and
  osd-edit.pages.dev for prod).
- **Top-left card** (glass, `rounded-2xl`, `bg-[var(--bg-glass)]`,
  `backdrop-blur-md`, `shadow-[var(--shadow-glass)]`): PR title +
  link back to GitHub, base/head SHAs (truncated to 7), "open in
  editor" link.
- **Right card** (same glass treatment, `md:w-[22rem]`): the changeset
  summary, grouped by resort then by entity kind:
  ```
  alpensia
    graph-node    -1   (1 removed)
    graph-edge    -6   (6 removed)
    slope         ±0
    lift          ±0
    geometry      ±0
  ```
  Per-entity rows are click-targets that pan/zoom the map to the
  affected feature. Each row carries a colored dot matching the map
  overlay (red/green/yellow).
- **Map layers**:
  - **Removed** (`#ef4444`, 60% opacity, dashed): nodes drawn as red
    rings, edges as dashed red polylines. Always rendered *below*
    "added" so green wins visual stacking when geometry overlaps.
  - **Added** (`#22c55e`, 80% opacity, solid): nodes as filled green
    dots, edges as solid green polylines.
  - **Modified geometry** (`#eab308`): old polyline dashed yellow,
    new polyline solid yellow, faint connector lines between vertex
    pairs that moved >5m.
  - **Unchanged context** (`#94a3b8`, 30% opacity): show as ghost so
    the reviewer can see *where* the changes sit in the resort, not
    just floating edits in empty space.
- **Empty geom-change case** (PR #2): summary panel shows green
  "no geometry changes — algorithmic only" banner at the top so
  Paul knows he doesn't need to squint at the map. The 6 removed
  dup edges still draw red so he can confirm they overlap their
  canonical twins (which are unchanged grey).

## Data flow

1. Browser parses query string → resolves base/head SHAs (one GitHub
   API call if `pr=N`; zero if already base/head).
2. Fetch the two diff payloads:
   - **Files-changed list**: `GET /repos/.../pulls/N/files` (for
     `pr=N`) or `GET /repos/.../compare/{base}...{head}` (for
     base/head). Both return a list of file paths + per-file patch.
3. For every file in `registry/**/{place,slopes,lifts,webcams,slope-graph}.json`,
   fetch *both* sides via raw URL:
   ```
   https://raw.githubusercontent.com/powder-nomad/open-ski-data/<sha>/<path>
   ```
   Raw URLs are unauthenticated, no rate limit headache for typical
   PR sizes. Parallelize with `Promise.all`.
4. Diff client-side by stable id (`scripts/check-stable-ids.mjs:58`
   on `main` documents the namespacing — `graph-edge:<slug>/<id>`,
   `slope:<slug>/<id>`, etc.). Compute `added`, `removed`,
   `geometryChanged` per kind per resort.
5. Render. No backend required — this is fully client-side, fits the
   Cloudflare Pages static-deploy model the editor already uses.

GitHub client to model after: `src/lib/github-client.ts` (Octokit
already imported, no extra dep). For public-repo reads you don't
need a token — but if rate-limited (60/hr unauth), reuse the existing
OAuth session token via `src/lib/use-session.ts`.

## File-level work plan

```
src/app/diff/
  page.tsx              ← route entry, parses query, kicks off load
  diff-view.tsx         ← main client component (mirrors editor.tsx shape)
  diff-summary.tsx      ← right panel
  use-pr-diff.ts        ← hook: query → {base, head, files, parsed}
src/lib/
  diff-graph.ts         ← pure diff fns over slope-graph.json shape
  diff-sidecar.ts       ← pure diff fns over slopes/lifts/webcams
scripts/audit.mjs
  + diff-empty-state    ← /diff with no params (landing)
  + diff-pr-2           ← /diff?pr=2 (or base/head fallback if merged)
```

Reuse aggressively:
- Map setup, glass tokens, mode toolbar styling: copy idioms from
  `src/app/editor/editor.tsx`. Do not extract into a shared component
  for one consumer — keep the duplication for now (YAGNI).
- `src/lib/resort-loader.tsx` knows how to hydrate a resort from
  registry shape; you may need a `loadResortFromShas(slug, sha)`
  variant that reads from raw GitHub instead of local fetch.

## Constraints (do not re-litigate)

- **Push to `pages` direct.** This is core/infra (the editor app
  itself), not community data. PRs are reserved for `main` data edits
  per Paul's standing rule.
- **Do not merge `pages` ↔ `main`.** Orphan branches by design.
- **Port 3017 only** for local dev (`npm run dev`). The Maps API key
  is allowlisted to that port; any other port silently 404s tiles.
- **Auth bypass for audit:** `NEXT_PUBLIC_AUDIT_MODE=1 npm run dev`
  short-circuits the OAuth check in `src/lib/use-session.ts`. Use
  this for the audit harness, never in prod.
- **Audit harness**: `scripts/audit.mjs` drives Playwright + system
  Chrome at `/usr/bin/google-chrome` (no bundled Chromium — uses
  `playwright-core`). Pattern for adding routes is in the existing
  file; copy the `loadFirstResort(page)` helper if you need to drive
  the map.
- **No new abstractions for one consumer.** The editor is 5,491
  lines and intentionally not extracted. The diff viewer should mirror
  that shape, not introduce a layout-shell HOC or similar.
- **Type discipline**: no `uppercase tracking-widest` eyebrows
  anywhere. Round 005 stripped 43 of them; don't reintroduce.

## Done criteria

- [ ] `osd-edit.pages.dev/diff?pr=2` (or `?base=...&head=...` fallback)
      loads, renders the map at Alpensia, shows the 6 dup edges in
      red overlapping their grey canonical twins, side panel summary
      reads "1 graph-node removed, 6 graph-edge removed, 0 geometry
      changes".
- [ ] Empty state (`/diff` no params) renders the glass shell with
      a "paste a PR link or SHA pair" prompt — no crash.
- [ ] Audit harness has `diff-pr-2` and `diff-empty-state` routes
      that capture screenshots, GAN rubric score ≥4 on every axis
      (atmospheric depth, spatial generosity, chrome minimalism, type
      discipline, color depth, polish).
- [ ] PR-body auto-comment is **out of scope for this handoff** —
      land the viewer first, then a follow-up wires it into the
      reference-data CI workflow on `main`.

## Smoke test

After deploy:

```bash
# Sanity: route resolves
curl -sI https://osd-edit.pages.dev/diff?pr=2 | head -1

# Local: full UX
NEXT_PUBLIC_AUDIT_MODE=1 npm run dev -- --port 3017
# → open http://localhost:3017/diff?pr=2 in the browser
# → confirm map renders Alpensia, red dashed dup edges visible
```

If PR #2 is merged by the time you ship: use
```
?base=6839b576cb1dda27f743639a137ad8cfd7a782f5
&head=1901dc4...   (or the actual merge commit's second parent)
```

## Open questions worth flagging back to Paul before shipping

1. **Auth on the diff route**: editor is OAuth-gated. Should `/diff`
   be public (it only reads public-repo data) or gated like the
   editor? Recommend public — lowers review friction.
2. **Multi-resort PRs**: future cleanup PRs may touch >1 resort.
   Spec assumes single-resort; multi-resort needs a resort switcher
   in the top-left card. Tag the issue, ship single-resort first.
3. **Non-graph files** (`place.json`, `webcams.json`): summary should
   show field-level diffs as a collapsible JSON view, not on the map.
   In scope or follow-up?

---

Once this is in flight, delete this file in the same commit that
lands the feature. It's a one-shot handoff, not living docs.
