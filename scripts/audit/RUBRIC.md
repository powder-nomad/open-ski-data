# Visual Audit Rubric — Google Earth Aesthetic

The evaluator scores each round's screenshots (`.audit/round-NNN/*.png`)
against two pinned dark-mode Google Earth reference shots:
- `scripts/audit/reference/google-earth-dark-1.png` — clean idle
  state, no panels populated (tooltip-only on map)
- `scripts/audit/reference/google-earth-dark-2.png` — populated
  side card with an elevation chart, drawing in progress

Six axes, each 1–5. A round ships when **every axis ≥ 4** — not on
average; on every axis.

## Pinned aesthetic — dark-mode Google Earth, concretely

What the references actually show, translated to CSS-able rules:

- **Floating chrome.** No edge-rails. Top utility bar is a
  translucent strip, not a solid bar. Side panel is a card with a
  rounded edge attached to the right, not a full-height pane. Bottom
  controls are floating circular buttons over the map.
- **Glass surfaces.** Panel backgrounds are dark-translucent
  (~`rgba(15,20,30,0.62)`) with `backdrop-filter: blur(12px)` so the
  map shows through faintly. No solid `#131a26` cards.
- **Depth via shadow, not borders.** Soft drop shadow
  (`0 8px 32px rgba(0,0,0,0.5)`) separates surfaces from the map.
  Hairline borders only where strictly needed
  (`rgba(255,255,255,0.05)`).
- **Generous rounding.** Panel corners ~`16px` (`rounded-2xl`),
  buttons ~`9999px` (pill), search bars ~`24px`.
- **Restrained type.** White-ish on glass, two weights max (400
  for keys, 500 for values), three sizes max in chrome, no SHOUTY
  UPPERCASE small caps.
- **Map dominance.** Chrome occupies ≤20% of the canvas at rest.
  All persistent chrome can be banished to a single corner or hidden
  on the top strip.
- **One accent.** Sky-blue (`--accent`) used sparingly — active
  states + single CTA. Drawing/markup color (yellow) is map-content,
  not chrome.

## Axes

### 1. Atmospheric depth (1–5)
Do surfaces feel like layered translucent panels in space, or flat?
- **5** — Frosted-glass overlays, soft inner glows, faint shadows
  cast by panels onto the map, blue-tinted blacks, gradient skies.
- **3** — Solid dark panels with hairline borders. No depth cues.
- **1** — Flat slate panels, no transparency, no shadow language.

### 2. Spatial generosity (1–5)
Breathing room. Comfortable density.
- **5** — Generous padding, ~24/32px section gaps, type fits at
  rest size (no shrunk-down 10px labels), buttons hit-target-friendly.
- **3** — Adequate but tight; labels readable but cramped.
- **1** — Compressed UI fighting itself for room. 9–10px type.

### 3. Chrome minimalism (1–5)
Does the UI recede or compete with the map?
- **5** — Chrome collapses or fades when idle. Map dominates ≥80%
  of the canvas at rest. Controls appear on hover or context.
- **3** — Persistent rails but visually quieter than the map.
- **1** — Chrome fights for visual weight, equal or louder than map.

### 4. Type discipline (1–5)
Restrained scale, clear hierarchy, no mixed-case noise.
- **5** — 2 weights max (e.g., 400/600), 3 sizes max in the chrome,
  consistent letter-spacing, no SHOUTY UPPERCASE small caps.
- **3** — Some hierarchy but mixed weights / cases / sizes.
- **1** — Type chaos: 5+ sizes, multiple weights, all-caps tags everywhere.

### 5. Color depth (1–5)
Rich, intentional palette. Atmospheric blues, not muddy grays.
- **5** — Deep saturated blues at depth, cool cyan-teal accents,
  warm-blue at "horizon" edges. Palette feels chosen, not default.
- **3** — Standard dark-theme grays + one accent.
- **1** — Slate-gray everything with a primary blue.

### 6. Polish (1–5)
Pixel alignment, motion easing, no jank.
- **5** — Everything sits on an 8/16px grid. Hover transitions ease
  in/out (not linear). Borders are 1px hairline or absent. No jaggy
  edges or low-contrast labels.
- **3** — Mostly aligned, snappy but linear transitions.
- **1** — Misaligned, jumpy hover states, dotted borders, jagged.

## Scoring procedure (each round)

1. Read `manifest.json` in the round dir.
2. View each shot alongside `reference/google-earth.png`.
3. Score each axis 1–5 with a one-sentence rationale.
4. List up to 3 specific concrete diffs the generator should apply
   next round (e.g. "drop `--bg-elev` from `#131a26` to `#0a1430`
   and add `backdrop-blur-md`").
5. Mark **ship** if every axis ≥ 4; otherwise **iterate**.

## Out of scope

- Functionality / interaction bugs (covered by other tests).
- Mobile / responsive behavior (audit is desktop-first, 1440×900).
- i18n string fit (covered by EN/KO key parity check).
- Map content (tile rendering is Google's — audit only the chrome
  around it).

## Iteration discipline

- **Pure CSS changes** (palette tokens in `globals.css`, Tailwind
  class swaps, spacing/typography tweaks) compose round-on-round
  without check-in.
- **Structural changes** (collapsing a rail, floating a panel,
  introducing a new component, repositioning a region) pause and
  ping the human reviewer with the diff + new shot before merging
  the round.
- Either way, every round commits a single squashed change-set;
  rollback is a single `git revert`.
