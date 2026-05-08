# open-ski-data editor (`pages` branch)

> ⚠️ **You are on the `pages` branch.** This branch is an **orphan**
> with no shared history with `main`. It holds the public-facing
> Next.js editor that contributors will use to add / update / delete
> resort data. The actual data + schemas live on `main`. Do not
> merge between branches.
>
> - **Editor (this branch):** `git checkout pages`
> - **Data + schemas (canonical):** `git checkout main`

Cloudflare Pages deploys from this branch; contributors sign in
with GitHub OAuth and submit edits as PRs to `main`.

---

## Architecture (fork-and-PR flow)

```
                    Contributor's browser
                           │
                           │ 1. signs in (GitHub OAuth, public_repo scope)
                           ▼
        ┌─────────────────────────────────────┐
        │ open-ski-data-editor on CF Pages    │
        │  • Next.js App Router + edge fns    │
        │  • Google Maps JS SDK (client-side) │
        │  • Octokit (GitHub REST API)        │
        └─────────────────────────────────────┘
                           │
                           │ 2. ensureFork → user/open-ski-data
                           │ 3. atomic commit on user's fork
                           │ 4. open PR back to powder-nomad/open-ski-data:main
                           ▼
                  GitHub upstream (main)
                           │
                           │ 5. existing CI on main runs against PR
                           │ 6. Paul reviews + manually merges
                           ▼
                       Merged to main
                  (registry index updates;
                   published apps pick it up)
```

The editor never has direct push access to the canonical repo.
Contributors get attribution on every PR (their GitHub username).
Schema validation runs as the existing `reference-data.yml` workflow
on `main`, gating the merge.

---

## Status — what's done on this branch so far

### Done (code complete; needs Paul's config to actually run)

- `git checkout --orphan pages` + clean tree
- Next.js 16 + React 19 + Tailwind + `@cloudflare/next-on-pages` scaffold (`package.json`, `tsconfig.json`, `next.config.mjs`, `tailwind.config.ts`, `postcss.config.mjs`, `.gitignore`, `.env.example`)
- App skeleton: `src/app/{layout,page,globals.css}.tsx` + `src/app/editor/{page,editor,mode-toolbar}.tsx`
- **Editor port:** `src/app/editor/editor.tsx` (2360 LOC, copied from `ski-platform/.../slope-author-2`) with 4 surgical edits applied:
  - imports use `@/lib/...` paths
  - `useSession` + `contribute` imported into the file
  - `/api/dev/elevation` → `/api/elevation`
  - `NewPlaceForm.submit()` posts via `contribute()` with a sign-in gate
- **GitHub client:** `src/lib/github-client.ts` — Octokit-based `ensureFork` / `commitFiles` / `openPullRequest` / `contribute` (Git Data API atomic multi-file commit, branches named `editor/<slug>-<UTC-ts>` on the user's fork, idempotent PR open)
- **OAuth flow (edge-runtime):** `src/app/api/auth/github/{login,callback}/route.ts`, `src/app/api/auth/{session,logout}/route.ts`, `src/lib/auth-session.ts` (HMAC-SHA256 signed `osd_session` cookie via Web Crypto, 7-day TTL)
- **Client session:** `src/lib/use-session.ts` (React hook returning `{ user, octokit, status, refresh }`) and `src/lib/ci-status.tsx` (new `PatchSaver` using `contribute()` — PR-based flow, no CI polling)
- **Session header chip:** `src/components/SessionHeader.tsx` — top-right floating chip; loading / Sign in / signed-in popover with profile + fork links + Sign out. Wired in the root layout.
- **Resort loader:** `src/lib/resort-loader.tsx` ported from v1 (already reads from `raw.githubusercontent.com/powder-nomad/open-ski-data/main`, no logic change needed)
- **Real i18n strings:** `src/messages/en.json` (slopeAuthor namespace, 64 keys ported from ski-platform). `src/lib/next-intl-stub.ts` upgraded from "return the key" to a real translator with `{name}`-style interpolation. Drop-in replaces `next-intl` via tsconfig path remap, so the editor compiles unchanged. Falls back to the literal key on missing strings (next-intl-style dev mode UX).
- **OAuth error surfacing:** `src/app/page.tsx` reads `?error=<reason>` from the callback redirect and renders a friendly banner mapping `oauth_state_mismatch` / `token_exchange_failed` / `access_denied` / etc. to human-readable messages.
- **Elevation proxy:** `src/app/api/elevation/route.ts` (edge-runtime port of ski-platform's route)
- **CI:** `.github/workflows/pages-build.yml` runs typecheck + `npm run pages:build` on push/PR to the `pages` branch. Uses dummy build-time env vars; CF Pages injects real ones at deploy time.

### Pending (Paul-only — can't be done from the dev VM)

| # | Task | Notes |
|---|---|---|
| 1 | **Register the OAuth app** at https://github.com/settings/developers | Scope: `public_repo`. Homepage URL: `https://<your-pages-domain>/`. Callback: `https://<your-pages-domain>/api/auth/github/callback`. Save the client id + secret. |
| 2 | **Set CF Pages env vars** (Production) | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_SECRET` (32-byte hex; `openssl rand -hex 32`), `GOOGLE_ELEVATION_API_KEY`, `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY`. Optional: `NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID` for vector styling. |
| 3 | **Configure Cloudflare Pages project** | Source = this repo, branch = `pages` only. Build command: `npm run pages:build`. Output dir: `.vercel/output/static`. Compatibility flag: `nodejs_compat`. |
| 4 | **Maps API referrer allowlist** in Google Cloud Console | Add `https://<your-domain>/*` and (optional) `https://*.<project>.pages.dev/*` for previews. |

### Deferred (v2 — no blocker for first deploy)

- `src/messages/{ko,ja}.json` — Korean and Japanese UI strings. Today's stub returns English regardless of `Accept-Language`. The editor's data-level i18n (slope/lift names in KO/EN/JA) is independent and already works.
- Drop the `next-intl` path remap and install the real package — needed once we add a locale switcher and want server-rendered locale routing.
- Per-action privilege rules (different review thresholds for add/update/delete). For now every PR hits manual merge by Paul.

---

## Setup (once Paul provides config)

```bash
# 1. install
cd /home/papercup/workspaces/open-ski-data && git checkout pages
npm install

# 2. populate .env.local from .env.example
#    GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET,
#    GOOGLE_ELEVATION_API_KEY, NEXT_PUBLIC_GOOGLE_MAPS_API_KEY

# 3. dev
npm run dev

# 4. CF Pages local preview
npm run pages:build
npm run pages:dev
```

### Cloudflare Pages config (when ready)

- **Project source:** this repo, **branch `pages` only** (Production).
  Don't deploy from `main` — `main` is data, not a webapp.
- **Build command:** `npm run pages:build`
- **Build output:** `.vercel/output/static`
- **Compatibility flags:** `nodejs_compat`
- **Environment variables (Production):**
  - `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` — OAuth app
  - `SESSION_SECRET` — 32-byte random for HMAC-signing the session cookie
  - `GOOGLE_ELEVATION_API_KEY` — server-side, kept off the bundle
  - `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` — client-side, referrer-restricted to your Pages domain in Google Cloud Console

### Maps API referrer allowlist (Google Cloud Console)

Add the production Pages hostname plus a wildcard for previews:
- `https://<your-domain>/*`
- `https://*.<project>.pages.dev/*` (preview deploys)

---

## Why orphan branch (vs separate repo)?

- **Pro:** one repo to clone for contributors; CF Pages deploy stays inside the same git remote.
- **Pro:** the editor's interaction model is tightly coupled to the `registry/` schema on `main` — co-locating them under one repo makes "schema change → editor change" trivially atomic at the org level.
- **Tradeoff:** people working on the editor and people contributing data are on different `git checkout`s. If that becomes friction in 6+ months, splitting to `powder-nomad/open-ski-data-editor` is a `git filter-repo --refs pages` + new remote away.

---

## What this branch does **not** do

- It does not serve `registry/`, `schemas/`, or any data files. Contributors load those directly from `https://raw.githubusercontent.com/powder-nomad/open-ski-data/main/...` (the existing `resort-loader.tsx` already does this).
- It does not have any of the `main` branch's CI workflows or scripts. It will get its own `.github/workflows/pages-build.yml` (lint + typecheck + `pages:build`) when ready.
- It does not run the legacy `snowple-bot` direct-merge-to-main shortcut from ski-platform. Public PRs go through the normal review path; Paul merges manually until automation rules are decided.
