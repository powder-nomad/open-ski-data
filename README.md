# open-ski-data editor (`pages` branch)

> ⚠️ **You are on the `pages` branch.** This branch is an **orphan**
> with no shared history with `main`. It holds the public-facing
> Next.js editor at <https://osd-edit.pages.dev>. The actual data
> + schemas live on `main`. Do not merge between branches.
>
> - **Editor (this branch):** `git checkout pages`
> - **Data + schemas (canonical):** `git checkout main`

The contributor-facing docs all live on `main` — start with
[**REPO-OVERVIEW.md**](https://github.com/powder-nomad/open-ski-data/blob/main/docs/REPO-OVERVIEW.md)
for the whole-project map and
[**EDITOR-GUIDE.md**](https://github.com/powder-nomad/open-ski-data/blob/main/docs/EDITOR-GUIDE.md)
for a panel-by-panel tour. This README is the engineer reference for
the editor itself: how it's built, how it deploys, and how to hack
on it locally.

## What ships at <https://osd-edit.pages.dev>

The editor lets a signed-in contributor edit any entity in the
open-ski-data registry — places, slopes, lifts, webcams, graph
nodes, graph edges — and saves their edits as a pull request to
`powder-nomad/open-ski-data:main`. There is no direct write access
to the canonical repo.

Features as of the latest deploy:

- **Welcome intro** — first-visit overlay (dismissible to localStorage,
  re-openable via the header `?` button) so cold visitors aren't
  dropped into a 10-mode toolbar with no orientation.
- **Per-resort autosave** — every edit serialises to
  `localStorage` under `osd-edit:draft:<cc>/<region>/<slug>` debounced
  750ms; on reload a `RestoreBanner` offers Restore / Discard with
  `Intl.RelativeTimeFormat` localised timestamps ("5 seconds ago" /
  "5초 전").
- **Conflict-awareness badge** — on resort load, queries upstream
  open PRs whose titles match the loaded resort and lists them in an
  orange `ConflictBadge` so contributors don't silently clobber
  each other.
- **Lint panel** — surfaces structural issues live (no-kind nodes,
  orphan nodes, slopes/lifts detached from the graph); each row jumps
  directly to the offending entity.
- **Patch preview** — sky-tinted summary of exactly what will ship
  in the PR (parts list + files + byte totals).
- **Per-operation undo** — 20-deep snapshot-based undo over all 13
  mutation states; selection / mode / picks are intentionally
  excluded.
- **Ten map modes** — pick, select, slope edit / draw, lift edit /
  draw, node add / edit, edge connect / edit. The active mode
  determines what a map click does; the header always shows it.
- **NewPlaceForm** — scaffold a brand-new resort directory
  (`place.json` + skeleton slopes / lifts / webcams) in one PR.
- **OSM import panel** — paste an OSM way ID to convert geometry
  into a slope or lift draft.
- **EN + KO i18n** — 172/172 key parity; locale detected from
  `navigator.language`. The data itself carries
  `name_i18n` / `label_i18n` maps for per-resort localisation.
- **GitHub OAuth (public_repo scope)** — HMAC-signed `osd_session`
  cookie, 7-day TTL, edge-runtime handshake.
- **AJV pre-submit validation** against the live schemas on `main`.
- **Provenance stamping** on every user-edited record
  (`source: "user-edit"`, `contributor: <login>`, `last_verified`).

## Architecture (fork-and-PR flow)

```text
                    Contributor's browser
                           │
                           │ 1. signs in (GitHub OAuth, public_repo scope)
                           ▼
        ┌─────────────────────────────────────┐
        │ open-ski-data-editor on CF Pages    │
        │  • Next.js 15.5 + React 19          │
        │  • Google Maps JS SDK (client-side) │
        │  • Octokit (GitHub REST API)        │
        │  • AJV (pre-submit validation)      │
        └─────────────────────────────────────┘
                           │
                           │ 2. ensureFork → user/open-ski-data
                           │ 3. atomic multi-file commit (Git Data API)
                           │ 4. open PR back to powder-nomad/open-ski-data:main
                           ▼
                  GitHub upstream (main)
                           │
                           │ 5. reference-data.yml CI runs on the PR
                           │ 6. maintainer reviews + merges
                           ▼
                       Merged to main
                  (registry index updates;
                   published apps pick it up via raw.githubusercontent.com)
```

The editor never has direct push access to the canonical repo.
Contributors get attribution on every PR (their GitHub username
authors the commit). Schema validation runs at three layers:
AJV pre-submit in the browser, the upstream `reference-data.yml`
workflow on the PR, and the maintainer review on the final merge.

Full sequence diagram + OAuth handshake + data-loading details:
[ARCHITECTURE.md on main](https://github.com/powder-nomad/open-ski-data/blob/main/docs/ARCHITECTURE.md).

## Stack

| Layer | Tech | Where |
|---|---|---|
| Framework | Next.js 15.5 App Router, React 19 | `src/app/*` |
| Edge runtime | Cloudflare Pages (`nodejs_compat`) | `wrangler` + `@cloudflare/next-on-pages` |
| Styling | Tailwind CSS 4 | `src/app/globals.css` |
| Map | `@googlemaps/js-api-loader` | `src/app/editor/editor.tsx` |
| GitHub API | `@octokit/rest` (client-side, authed with user token) | `src/lib/github-client.ts` |
| Schema validation | `ajv` + `ajv-formats` | `src/lib/schema-validator.ts` |
| i18n | `src/lib/next-intl-stub.tsx` (drop-in for `next-intl`) | `src/messages/{en,ko}.json` |
| Session | HMAC-signed cookie, Web Crypto | `src/lib/auth-session.ts` |

## File layout

```text
src/
  app/
    page.tsx                       ← root route (renders SlopeAuthor2)
    editor/
      editor.tsx                   ← the editor itself (~5000 LOC)
      mode-toolbar.tsx             ← left-side mode switcher
      page.tsx                     ← /editor synonym for back-compat bookmarks
    api/
      auth/github/login/route.ts   ← redirects to github.com OAuth
      auth/github/callback/route.ts← code → token → cookie
      auth/session/route.ts        ← cookie → {login, accessToken}
      auth/logout/route.ts         ← clear cookie
      elevation/route.ts           ← proxies Google Elevation API
  lib/
    github-client.ts               ← Octokit fork-and-PR helpers
    use-session.ts                 ← React hook for the auth state
    ci-status.tsx                  ← PatchSaver (save = PR)
    resort-loader.tsx              ← reads from raw.githubusercontent on main
    next-intl-stub.tsx             ← minimal next-intl-compatible translator
    schema-validator.ts            ← AJV pre-submit check against main schemas
    auth-session.ts                ← HMAC-signed cookie helpers (edge runtime)
    runtime-config.ts              ← runtime env-var loader
    geo.ts                         ← lat/lng helpers (snapToNearest etc.)
  messages/
    en.json                        ← editor UI strings (English, 172 keys)
    ko.json                        ← editor UI strings (Korean, 172 keys)
  components/
    SessionHeader.tsx              ← top-right floating session chip
.github/workflows/
  pages-build.yml                  ← typecheck + pages:build on every push
```

## Local development

```bash
# install
git checkout pages
npm install

# populate .env.local from .env.example (see Env vars below)

# dev server
npm run dev

# CF Pages local preview (matches production edge runtime)
npm run pages:build
npm run pages:dev

# type-only check
npm run typecheck
```

## Deploy

CF Pages builds + deploys automatically on every push to `pages`.
Manual deploys when needed:

```bash
git checkout pages
npm run pages:build
npx wrangler pages deploy .vercel/output/static \
  --project-name=osd-edit --branch=pages \
  --commit-message="<short title>"
```

The CF Pages `--commit-message` caps at ~1KB; pass a short title and
let the git commit on `pages` carry the long body.

## Env vars (CF Pages → Production)

- `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — OAuth app credentials
- `SESSION_SECRET` — 32-byte hex for HMAC-signing the session cookie
  (`openssl rand -hex 32`)
- `GOOGLE_ELEVATION_API_KEY` — server-side; kept off the bundle
- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — client-side; referrer-restricted
  to the Pages domain in Google Cloud Console
- `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` — optional, enables vector
  styling

Names only — values live in the CF Pages dashboard, never in this
repo. The OAuth callback URL must match the deployed domain
(`https://<your-domain>/api/auth/github/callback`).

## Maps API referrer allowlist (Google Cloud Console)

Add the production hostname + a wildcard for previews:

- `https://<your-domain>/*`
- `https://*.<project>.pages.dev/*`

## CI

`.github/workflows/pages-build.yml` runs typecheck + `npm run pages:build`
on every push and PR to `pages`. CF Pages runs the same build when
deploying; the GitHub Actions step lets us reject broken commits
before Pages picks them up. Build-time env vars in CI are dummies —
the runtime env vars get injected by CF Pages at request time.

## Browser storage

The editor stores three things in your browser, all under your control:

- **Per-resort drafts** (`osd-edit:draft:<cc>/<region>/<slug>`) —
  in-flight edits, debounced autosave. Cleared on Discard or
  successful save.
- **Welcome dismissal** (`osd-edit:welcome-seen`) — prevents the
  intro panel from reappearing after dismissal.
- **OAuth session cookie** (`osd_session`, HMAC-signed, HTTP-only,
  7-day TTL) — kept by the contributor's signed-in session.

No analytics, no third-party trackers. Network egress is limited to
GitHub (save) and Google Maps (tile rendering) + the Elevation API
proxy.

## Why orphan branch (vs separate repo)

- One repo to clone for contributors who want to look at both data
  and editor.
- The editor's interaction model is tightly coupled to the
  `registry/` schema on `main` — co-locating them under one repo
  makes "schema change → editor change" trivially atomic at the org
  level.
- Trade-off: people working on the editor and people contributing
  data are on different `git checkout`s. If that becomes friction
  in 6+ months, splitting to `powder-nomad/open-ski-data-editor` is
  a `git filter-repo --refs pages` + new remote away.

## What this branch does **not** do

- It does not serve `registry/`, `schemas/`, or any data files.
  The editor reads those at runtime from
  `https://raw.githubusercontent.com/powder-nomad/open-ski-data/main/...`
  via `src/lib/resort-loader.tsx`.
- It does not have any of `main`'s CI workflows or scripts.
- It does not run a bot identity or direct-merge automation. Every
  PR goes through maintainer review.
