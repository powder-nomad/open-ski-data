# Repository overview

A map of the whole project: branches, directories, lifecycle, and
where to start depending on what you came here to do.

## Two branches, one repo

`open-ski-data` uses two **orphan** branches with no shared history.
This is deliberate: data lives on one, the editor that maintains it
lives on the other, and tooling on each branch never imports from
the other.

| Branch | Purpose | What's there | Default branch on GitHub |
|---|---|---|---|
| `main` | Canonical data + schemas | `registry/`, `schemas/`, `scripts/`, this `docs/` | ✓ |
| `pages` | Public web editor | Next.js app, GitHub OAuth, Cloudflare Pages deploy | |

Cloudflare Pages deploys `pages` to **<https://osd-edit.pages.dev>**.
The editor never has direct push access to `main` — every save is a
pull request that a maintainer reviews and merges. See
[ARCHITECTURE.md](./ARCHITECTURE.md) for the full flow.

Switching: `git checkout main` for data work,
`git checkout pages` for editor work. Do **not** try to merge
between them; the histories don't relate.

## Where to start

| You want to… | Go here |
|---|---|
| Use the data in an app | The [README](../README.md) "Consumers" section + [SCHEMAS.md](./SCHEMAS.md) |
| Add or fix a resort with a few clicks | [EDITOR-GUIDE.md](./EDITOR-GUIDE.md) (just open <https://osd-edit.pages.dev>) |
| Add or fix a resort via pull request | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Rename a slug after release | [SLUG-LIFECYCLE.md](./SLUG-LIFECYCLE.md) |
| Understand the data shapes | [SCHEMAS.md](./SCHEMAS.md) |
| Hack on the editor itself | [ARCHITECTURE.md](./ARCHITECTURE.md) + `git checkout pages` |

## `main` branch layout

```text
.
├── README.md            ← project overview, license, layout, consumer guide
├── CONTRIBUTING.md      ← rules + provenance + path conventions
├── LICENSE              ← dual-license notice (points to the two below)
├── LICENSE-DATA         ← ODbL-1.0 (registry/, schemas/)
├── LICENSE-CODE         ← MIT (scripts/, validators, app code)
├── NOTICE               ← OpenStreetMap attribution (required by ODbL)
├── docs/
│   ├── REPO-OVERVIEW.md ← (this file)
│   ├── EDITOR-GUIDE.md  ← contributor-facing tour of the web editor
│   ├── SCHEMAS.md       ← entity-by-entity field reference
│   ├── ARCHITECTURE.md  ← engineer-facing stack overview
│   └── SLUG-LIFECYCLE.md← rename rules + aliases ledger
├── registry/            ← the actual data (per-resort directories)
│   ├── index.json       ← list of country indexes
│   ├── aliases.json     ← slug rename ledger (see SLUG-LIFECYCLE.md)
│   ├── <country>/
│   │   ├── index.json   ← list of region indexes
│   │   └── <region>/
│   │       ├── index.json     ← list of places in this region
│   │       └── <slug>/
│   │           ├── place.json       ← canonical place record
│   │           ├── slopes.json      ← runs / trails
│   │           ├── lifts.json       ← lifts + connections
│   │           ├── webcams.json     ← webcam metadata
│   │           └── slope-graph.json ← routing graph (optional)
│   └── ski-domains/
│       ├── index.json   ← list of multi-resort domains
│       └── *.json       ← each domain's member list
├── schemas/             ← JSON Schemas (one per entity)
└── scripts/
    ├── README.md        ← import pipeline (OSM → registry)
    ├── import_resort.py ← Python OSM importer
    └── check-*.mjs      ← Node validators (referenced from CI)
```

## `pages` branch layout (summary)

```text
.
├── README.md            ← deploy + feature overview for the editor
├── src/
│   ├── app/
│   │   ├── page.tsx           ← root route, renders the editor
│   │   ├── editor/editor.tsx  ← the editor itself (~5000 LOC)
│   │   ├── editor/mode-toolbar.tsx  ← left-side mode switcher
│   │   └── api/auth/github/*  ← OAuth callback + session edge functions
│   ├── lib/
│   │   ├── github-client.ts   ← Octokit fork-and-PR helpers
│   │   ├── use-session.ts     ← React hook for the auth state
│   │   ├── ci-status.tsx      ← PatchSaver (save = PR)
│   │   ├── resort-loader.tsx  ← reads from raw.githubusercontent on main
│   │   ├── next-intl-stub.tsx ← minimal next-intl-compatible translator
│   │   ├── schema-validator.ts← AJV pre-submit check against main schemas
│   │   └── auth-session.ts    ← HMAC-signed cookie helpers (edge runtime)
│   └── messages/
│       ├── en.json            ← editor UI strings (English)
│       └── ko.json            ← editor UI strings (Korean)
└── .github/workflows/
    └── pages-build.yml        ← typecheck + pages:build on every push
```

`pages` does not contain any of `registry/`, `schemas/`, or the
import scripts from `main`. The editor reads schemas directly from
`raw.githubusercontent.com/powder-nomad/open-ski-data/main/...` at
runtime, so a schema change on `main` shows up in the live editor
without a redeploy.

## Lifecycle of a contribution

```text
contributor opens https://osd-edit.pages.dev
        │
        │ 1. picks a resort, edits a slope / lift / node / etc.
        │ 2. signs in with GitHub (public_repo scope)
        ▼
  editor "Save" button
        │
        │ 3. fork powder-nomad/open-ski-data → contributor's account
        │ 4. atomic commit on the fork (Git Data API)
        │ 5. open PR back to powder-nomad/open-ski-data:main
        ▼
  GitHub upstream main
        │
        │ 6. CI (.github/workflows/reference-data.yml) validates the PR
        │ 7. maintainer reviews + merges
        ▼
  merged to main
        │
        │ 8. raw.githubusercontent.com serves the new files immediately
        ▼
  every consumer (apps, APIs, the editor itself) sees the update
```

The same lifecycle holds for a PR opened by hand (no editor). The
editor is just a more convenient way to author the commit.

## Out-of-tree dependencies

Two external surfaces affect the editor:

- **GitHub OAuth app** — registered by the project owner; its
  client id is configured in Cloudflare Pages env vars and the
  callback URL points at `/api/auth/github/callback`. Contributors
  authorize once per browser; the session cookie lasts 7 days.
- **Google Maps JS SDK** — the editor renders the map via the
  client-side SDK. The API key is referrer-restricted to the Pages
  domain in Google Cloud Console.

Both are configured outside this repo; only their env-var **names**
appear in `.env.example` on `pages`.
