# Architecture

For engineers who want to understand or change how the editor and
the data registry fit together. Contributors who just want to fix
a resort should read [EDITOR-GUIDE.md](./EDITOR-GUIDE.md) instead.

## Big picture

```text
┌────────────────────────────────────────────────────────────────┐
│  Contributor's browser                                         │
│                                                                │
│   https://osd-edit.pages.dev (CF Pages, branch=pages)          │
│   • Next.js 15 App Router, React 19                            │
│   • Google Maps JS SDK (tile + polyline rendering)             │
│   • Octokit (client-side, authed with the user's OAuth token)  │
│   • AJV (pre-submit schema validation)                         │
│                                                                │
│   ── reads ──→ raw.githubusercontent.com/.../main/...          │
│       (registry JSON + schemas; no auth, no rate-limit issue)  │
└────────────────────────────────────────────────────────────────┘
                    │             ▲
              (PR)  │             │ (read for diff baseline)
                    ▼             │
┌────────────────────────────────────────────────────────────────┐
│  GitHub: powder-nomad/open-ski-data (branch=main)              │
│                                                                │
│   registry/, schemas/, scripts/, docs/                         │
│                                                                │
│   .github/workflows/reference-data.yml validates every PR.     │
│   A maintainer reviews + merges. raw.githubusercontent.com     │
│   serves the merged files immediately to every consumer.       │
└────────────────────────────────────────────────────────────────┘
                    ▲
                    │  (server-side, the auth handshake only)
                    │
┌────────────────────────────────────────────────────────────────┐
│  CF Pages edge functions (branch=pages, runtime=edge)          │
│  /api/auth/github/login    initiates OAuth                     │
│  /api/auth/github/callback exchanges code → token,             │
│                            sets HMAC-signed `osd_session` cookie│
│  /api/auth/session         reads cookie → {login, accessToken} │
│  /api/auth/logout          clears the cookie                   │
│  /api/elevation            proxies Google Elevation API        │
└────────────────────────────────────────────────────────────────┘
```

## Two branches, one repo

`main` and `pages` are **orphan** branches with no shared history.
Don't try to merge them — git will refuse, and even with
`--allow-unrelated-histories` you'd get a tree that nothing in CI
or in Cloudflare Pages knows how to handle.

- `main` is the data + schemas + import scripts. CI here:
  `.github/workflows/reference-data.yml`. No webapp code.
- `pages` is the Next.js editor. CI here:
  `.github/workflows/pages-build.yml` (typecheck + `pages:build`).
  No data files.

Cloudflare Pages is configured to deploy **only** from `pages`.

## How "save" really works

The PR flow is the only path that mutates the registry. The editor
implements it client-side, with the user's GitHub OAuth token.

1. Pre-submit: AJV (`src/lib/schema-validator.ts` on `pages`)
   validates the full patch bundle against the live schemas
   fetched from `main`. Catches malformed payloads before they
   reach GitHub.
2. Confirm: a native `confirm()` dialog spells out the edit tally.
3. `ensureFork(octokit, user.login)` — creates the user's fork if
   it doesn't exist; polls until GitHub has finished provisioning
   it. Idempotent.
4. `commitFiles(...)` — Git Data API, atomic multi-file:
   - get the upstream `main` SHA
   - create a fresh branch `editor/<slug>-<UTC-timestamp>` on the
     fork, pointing at the upstream tip
   - build a new tree with the changed files
   - create a commit on that tree, parented on the upstream tip
   - update the branch ref to point at the new commit
5. `openPullRequest(...)` — opens the PR from
   `<user>:editor/<slug>-<ts>` → `powder-nomad:main`. The PR title
   is the commit message; the body credits the editor.
6. The editor clears the per-resort autosave entry from
   localStorage (so the restore prompt doesn't fire on next visit).

There's no server-side queue, no bot identity. Every commit is
authored by the GitHub user; every PR is theirs to amend or close
if the maintainer requests changes.

## Auth: HMAC-signed cookie, server-side handshake

The OAuth handshake runs on the edge so the client secret never
ships to the browser:

1. `/api/auth/github/login` redirects the user to
   `github.com/login/oauth/authorize` with a freshly-minted
   `state` cookie.
2. GitHub redirects back to `/api/auth/github/callback?code=…&state=…`.
3. The callback verifies the `state` matches, exchanges the code
   for an access token, and writes the access token + login into
   the `osd_session` cookie.
4. The cookie is HMAC-SHA256 signed with `SESSION_SECRET` (set in
   CF Pages env vars; rotated by Paul). 7-day TTL. HTTP-only.
5. The client polls `/api/auth/session` once per page load to get
   back `{login, accessToken}` (the access token is exposed to JS
   on purpose — the client uses it to talk to GitHub directly).

The full implementation is in `src/lib/auth-session.ts` and
`src/app/api/auth/github/*` on `pages`. The same shape would work
for any other OAuth provider.

## Data loading

The editor never bundles the registry — it fetches at runtime
from `raw.githubusercontent.com/powder-nomad/open-ski-data/main/...`.
That keeps the editor decoupled from data updates: a contributor
merges to `main`, and the next editor load picks up the new files
without any redeploy.

Schemas are fetched the same way (used by AJV pre-submit).
Resort manifest is walked through the hierarchical indexes
(`registry/index.json` → country → region → place).

Cache: the browser handles HTTP caching against
`raw.githubusercontent.com` with the default headers GitHub
serves. There's no Service Worker.

## Stack details (pages branch)

| Layer | Tech | Where to look |
|---|---|---|
| Framework | Next.js 15.5 App Router, React 19 | `src/app/*` |
| Edge runtime | Cloudflare Pages (`nodejs_compat`) | `wrangler` + `@cloudflare/next-on-pages` |
| Styling | Tailwind CSS 4 | `src/app/globals.css` |
| Map | `@googlemaps/js-api-loader` | `src/app/editor/editor.tsx` |
| GitHub API | `@octokit/rest` (client-side, authed with user token) | `src/lib/github-client.ts` |
| Schema validation | `ajv` + `ajv-formats` | `src/lib/schema-validator.ts` |
| i18n | `src/lib/next-intl-stub.tsx` (drop-in for `next-intl`) | `src/messages/{en,ko}.json` |
| Session | HMAC-signed cookie, Web Crypto | `src/lib/auth-session.ts` |

The `next-intl-stub.tsx` is a minimal API-compatible replacement
for the real `next-intl` package. Trade-off: a brief (~50ms) EN
flash on KO browsers because locale detection runs in a
`useEffect`. Documented in the stub; the cleaner server-side fix
is blocked by a `@cloudflare/next-on-pages 1.13` bug
(`/_not-found` can't inherit `runtime = "edge"` from a layout).

## CI

### `main` branch — `.github/workflows/reference-data.yml`

Runs on every push and PR to `main`. Validates:

- All `registry/**.json` files against their schemas.
- Slug pattern conformance.
- Aliases ledger well-formedness.
- Provenance coverage (warn mode — opt-in tightening later).

### `pages` branch — `.github/workflows/pages-build.yml`

Runs on every push and PR to `pages`. Validates:

- TypeScript typecheck (`tsc --noEmit`).
- `npm run pages:build` succeeds — catches missing i18n keys, AJV
  schema regressions, edge-runtime incompatibilities.

CF Pages itself runs the same build when deploying, but the GitHub
Actions step lets us reject broken commits before Pages picks them
up.

## Deploy

Cloudflare Pages is configured manually (one-time):

- Source: this repo, branch = `pages` only (Production).
- Build command: `npm run pages:build`.
- Build output: `.vercel/output/static`.
- Compatibility flag: `nodejs_compat`.
- Env vars (Production):
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`
  - `SESSION_SECRET` (32-byte hex; `openssl rand -hex 32`)
  - `GOOGLE_ELEVATION_API_KEY` (server-side)
  - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` (client-side; referrer-restricted)
  - `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` (optional, for vector styling)

Manual deploys when needed:

```bash
git checkout pages
npm run pages:build
npx wrangler pages deploy .vercel/output/static \
  --project-name=osd-edit --branch=pages \
  --commit-message="<short title>"
```

The CF Pages commit-message field caps at ~1KB; pass a short
`--commit-message` and let the git commit on `pages` carry the
long body.

## Adding a new entity type

Suppose you want to add `parking.json` per-resort. The path:

1. **Schema first**: write `schemas/parking.schema.json` on `main`.
2. **Validator**: add a case to `scripts/check-reference-data.mjs`
   (the script that CI runs).
3. **Editor**: on `pages`, extend `LoadedResort` in
   `src/lib/resort-loader.tsx`, add a `useState` for the override,
   add to the `currentSnapshot` for autosave / undo, add a meta
   panel + (if needed) a draw mode.
4. **i18n**: add string keys to both `src/messages/en.json` and
   `ko.json`.
5. **PatchSaver**: extend `EditSummary` in `src/lib/ci-status.tsx`
   so the edit tally surfaces the new entity in the PR body.

The schema is the load-bearing first step — once it's on `main`,
the editor can validate against it via the live fetch even before
the editor itself knows how to surface the new fields.

## Adding a new locale

1. Write `src/messages/<lang>.json` on `pages`, mirroring every
   key in `en.json`.
2. Register the locale in `SUPPORTED_LOCALES` in
   `src/lib/next-intl-stub.tsx`.
3. That's it. `navigator.language` detection picks it up. Existing
   data carries `name_i18n` maps keyed by the same locale codes.

There's no per-locale routing today (everything is at `/`); the
stub just swaps strings based on `navigator.language`.

## Observability

Honest answer: there isn't much. CF Pages dashboard shows
deploy logs and basic request metrics. There's no Sentry, no
log forwarding, no analytics. The editor stores nothing
server-side beyond the OAuth handshake cookie.

If a contributor reports a bug, the only forensic data is:

- The browser's localStorage (`osd-edit:draft:<...>`) — they can
  paste this into an issue.
- The GitHub PR (if save succeeded).
- The CF Pages access log (only Paul has access).

That's adequate for the current scale. Adding error logging
is a future iteration.
