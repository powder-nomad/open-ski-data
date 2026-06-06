# Editor guide

A tour of the open-ski-data web editor at **<https://osd-edit.pages.dev>**.
You don't need to read this to use it — the editor is meant to be
walk-up-discoverable — but this is the canonical reference for
"what can I do, what does this button mean, what happens when I
click save."

## Audience

Anyone who knows a ski resort better than the current data and is
willing to spend ten minutes correcting it. You don't need to be a
developer. You do need a GitHub account (free) to save.

## The 60-second loop

1. Open <https://osd-edit.pages.dev>.
2. First time? Read the **welcome panel** at the top of the sidebar
   (you can re-open it later with the `?` button in the header).
3. Pick a resort from the **Edit existing resort** dropdown.
4. The map zooms in with every slope, lift, and routing node already
   drawn on top of it.
5. Use the **mode toolbar** on the left to choose what your next
   click does (select a slope, draw a new lift, edit a node…).
6. Make your edits. Everything is shown live on the map; a **patch
   preview** in the sidebar summarises what will ship.
7. Click **Open PR** in the **Save as PR** panel. You'll be asked to
   sign in with GitHub on the first save (every save creates a pull
   request against `powder-nomad/open-ski-data:main` under your
   account; a maintainer reviews and merges).

That's it. The rest of this doc explains every panel and mode in
order, and what happens behind the curtain.

## What you can edit

The editor covers every entity in the data registry:

- **Places** — the resort itself: name, region, country, location,
  base/summit elevations, tags. Edit via the **Place** meta panel.
- **Slopes** — every run / trail on the mountain: name (with
  per-locale variants), difficulty, type. Draw new ones with
  **`+` slopes** mode, edit geometry with **Slope edit**, or change
  metadata in the slope's meta panel.
- **Lifts** — every lift, gondola, magic carpet: name, type,
  capacity, length, vertical. Same modes as slopes (**`+` lifts**,
  **Lift edit**).
- **Webcams** — webcam URLs, labels, refresh intervals.
- **Graph nodes** — the routing graph's joints (forks, merges,
  summits, bases, lift stations). Drop new ones with **`+` node**,
  edit kind / elevation / position with **Node** mode.
- **Graph edges** — the connecting segments between nodes. Two ways
  to author: **Edge** mode chains nodes into multi-segment edges
  ("connect-nodes" in the toolbar), or you draw an edge directly
  via **Edge edit**. Edges carry kind (slope / lift / traverse).

The only thing you can't change through the editor is the **JSON
schema itself** — that's a maintainer-only concern and lives in
`schemas/` on the `main` branch.

## Sidebar tour, top to bottom

The sidebar (right side on desktop, bottom drawer on mobile) is the
editor's control surface. Panels appear and disappear based on what
you've done.

### 1. Welcome panel (first visit)

Sky-tinted, three numbered steps explaining the basics. Dismissed
with **Got it** — never appears again on this browser. Re-open
anytime with the `?` button in the header.

### 2. Edit existing resort

A dropdown of every resort in the registry, indexed live from
`registry/index.json` on `main`. Pick one and the map zooms in;
all slopes, lifts, and routing data load on top.

### 3. Restore unsaved edits (when applicable)

Amber-tinted, appears if you closed the editor mid-edit on this
browser. Shows when the last save-in-progress happened
("saved 5 minutes ago" / "5분 전 저장됨"). **Restore** brings your
edits back exactly as they were; **Discard** drops them. Either
way the saved draft is cleared.

Autosave writes every edit (debounced 750ms) to your browser's
`localStorage` under `osd-edit:draft:<country>/<region>/<slug>`.
It's per-resort, so switching between resorts doesn't trample
drafts. Successful PR submissions also clear the draft.

### 4. Open PRs touching this resort (when applicable)

Orange-tinted, appears if upstream already has open pull requests
whose titles touch the current resort. Each row links to the PR
and names the author. Use it to coordinate before you save and
clobber someone's in-flight work.

### 5. New place / ski area

Collapsed by default. Expand to create a brand-new resort entry
(country code, region, slug, name, coordinates, optional
elevations / tags). Submits a PR that adds an empty
`registry/<cc>/<region>/<slug>/` directory with skeleton
`place.json` / `slopes.json` / `lifts.json` / `webcams.json`.

### 6. Mode-specific panels

The middle of the sidebar reshuffles based on the active mode and
what you've selected:

- **Pick mode**: list of dropped pins + elevation lookups.
- **Slope draw / edit**: vertex list, snap status, finalise button.
- **Lift draw / edit**: same as slope but for lifts.
- **Node add / edit**: kind dropdown, elevation field, position
  display, delete button.
- **Edge connect / edit**: from/to endpoints, kind selector,
  geometry preview, delete button.
- **Merge close nodes**: surfaces pairs of nodes within a snap
  tolerance so you can collapse duplicates into one.
- **OSM import**: paste an OpenStreetMap way ID to fetch and
  convert its geometry into a slope / lift draft.
- **Lint panel**: validation issues against the live data — nodes
  with no `kind`, orphan nodes, slopes/lifts not attached to the
  graph. Click any row to jump straight to the offending entity.

### 7. Patch preview (when you have edits)

Sky-tinted. Lists exactly what will ship in your pull request:
human-readable parts ("edit 3 slopes + add 1 lift + edit 2 graph
nodes") and the files that will be touched, with byte sizes.
This is what reviewers see in the PR.

### 8. Undo (when you have edits)

Violet-tinted. "Undo last edit" reverts the most recent change.
Holds up to 20 steps. Selection, mode, and other UI state are
intentionally excluded — undo only reverts edits, never
teleports the cursor.

### 9. Save as PR

The bottom of the sidebar. Shows:

- A **Sign in with GitHub** button if you're not authenticated
  (one-tap OAuth; the editor never sees your password).
- The "Pending" tally once you are signed in.
- An **Open PR with N edits** button. Clicking it forks the repo
  to your GitHub account on first use, pushes an atomic
  multi-file commit to a fresh branch, and opens a pull request
  back to `powder-nomad/open-ski-data:main`.
- After success, links to the PR + commit SHA.

## Mode toolbar (left side / top strip on mobile)

Ten modes, each with an icon and label. The active mode determines
what a click on the map does. The header always shows
"Mode: `<active label>`" so you never lose track.

| Icon | Mode | What a map click does |
|---|---|---|
| 📍 | **Pick** | Drop a coordinate pin, fetch elevation, list it |
| 👆 | **Select** | Select an existing slope / lift / node / edge for editing |
| ✎ | **Slope edit** | Drag vertices on the selected slope's polyline |
| ✚ | **+ Slope** | Draw a brand-new slope polyline |
| 🚡 | **Lift edit** | Drag vertices on the selected lift's polyline |
| 🚠 | **+ Lift** | Draw a brand-new lift polyline |
| ● | **+ Node** | Drop graph nodes (with auto-snap dedup) |
| ─ | **Edge** | Connect two nodes — or chain several — into edges |
| ↔ | **Edge edit** | Drag the geometry vertices of the selected edge |
| ◉ | **Node** | Edit a node's kind, elevation, or position |

Modes that **require a selection first** (Slope edit / Lift edit /
Edge edit / Node) appear disabled until you select something in
**Select** mode.

On mobile the toolbar becomes a horizontal strip across the top of
the drawer; you can scroll it sideways to reach all ten modes.

## Saving — what really happens

1. You click **Open PR with N edits**.
2. The editor runs a final pre-submit AJV check against the live
   schemas on `main`. If your edits are malformed (missing required
   field, bad enum, additional property not allowed), the save
   stops here with a human-readable error.
3. The editor confirms with a browser dialog showing the edit
   tally.
4. **First save only**: GitHub forks `powder-nomad/open-ski-data`
   to your account.
5. The editor pushes a single commit to a fresh branch on your fork
   (`editor/<slug>-<UTC-timestamp>`) using the Git Data API —
   atomic multi-file, no intermediate empty states.
6. The editor opens a pull request from your fork's branch back to
   `powder-nomad/open-ski-data:main`. The PR title is the same as
   the commit message; the body credits "Submitted via the
   open-ski-data web editor" + the edit tally.
7. Upstream CI runs the validators on the PR. A maintainer reviews
   and merges. The merged data is live on
   `raw.githubusercontent.com` immediately.
8. The editor clears your local autosave for that resort so the
   restore prompt doesn't reappear on next visit.

Your edits are credited to your GitHub username and your commits
are authored by you (so `git blame` and the contributor graph
both show your work).

## Provenance is automatic

Every edit you make through the editor stamps the affected record
with a `provenance` block:

- `source: "user-edit"`
- `contributor: "<your-github-username>"`
- `last_verified: "<today's UTC date>"`

You don't need to fill these in manually. They become part of the
PR diff and let downstream reviewers see at a glance whether the
change was an OSM import, an official source, or a contributor
correction. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full
provenance shape.

## Languages

The UI ships in English and Korean and detects from the browser's
`navigator.language` on mount. EN is the default; KO swaps in
automatically for `ko-*` locales. The data itself carries
`name_i18n` / `label_i18n` maps for per-resort localisation —
those are edited directly through each meta panel's
"Localized names" section.

## Privacy

The editor stores three things in your browser, all under your
control:

- **Per-resort drafts** (`osd-edit:draft:*`) — your in-flight
  edits. Cleared on Discard or successful save.
- **Welcome dismissal** (`osd-edit:welcome-seen`) — so the intro
  panel doesn't reappear after you've read it.
- **OAuth session cookie** (`osd_session`, HMAC-signed,
  HTTP-only, 7-day TTL) — keeps you signed in for the session.
  Sign out clears it.

The editor itself runs no analytics, no third-party trackers, and
sends no data anywhere except GitHub (for save) and Google Maps
(for tile rendering).

## Trouble?

- **"Save failed: Schema validation failed (N issues)"** — your
  edits don't match the schema. The error message lists each path
  and what's wrong. Fix in the editor, save again.
- **"Save failed: API rate limit exceeded"** — GitHub's rate limit
  for your account is full. Wait an hour, or sign out + back in
  to refresh.
- **Welcome panel won't go away** — click **Got it**. If it
  reappears on every reload, your browser is blocking
  localStorage (private / incognito mode).
- **Map doesn't load** — the Google Maps API key may be
  misconfigured. Refresh; if it persists, open an issue.
- **Anything else** — open an issue at
  <https://github.com/powder-nomad/open-ski-data/issues>.
