"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

/**
 * Editor mode — the single piece of state that decides what a
 * map-click does. Only one mode active at a time. Visualised as a
 * left-side vertical toolbar so the user can always see what's on
 * without scrolling.
 *
 * Modes implemented today:
 *   - `pick`              click drops a coordinate pin + fetches elevation
 *   - `select`            click selects an existing slope / lift / node for editing
 *   - `edit-slope-geom`   selected slope's polyline becomes editable (drag, insert, append)
 *
 * Modes scaffolded for follow-up commits (visible but disabled):
 *   - `draw-slope`        draw a brand-new slope polyline
 *   - `edit-lift-geom`    same as edit-slope-geom but for a selected lift
 *   - `draw-lift`         draw a brand-new lift polyline
 *   - `add-node`          drop graph nodes (with POI types)
 *   - `connect-nodes`     pick two nodes → create an edge between them
 *   - `edit-edge`         drag edge geometry vertices
 */
export type EditorMode =
  | "pick"
  | "select"
  | "edit-slope-geom"
  | "draw-slope"
  | "edit-lift-geom"
  | "draw-lift"
  | "add-node"
  | "connect-nodes"
  | "edit-edge";

/**
 * Translation keys for each mode. Descriptors no longer carry display
 * strings — both this file and editor.tsx resolve `labelKey`/`hintKey`
 * against `useTranslations("slopeAuthor")` so the toolbar + the cursor
 * badge stay in sync across EN and KO.
 */
export const MODE_I18N: Record<EditorMode, { labelKey: string; hintKey: string }> = {
  pick: { labelKey: "pickMode", hintKey: "pickHint" },
  select: { labelKey: "selectMode", hintKey: "selectHint" },
  "edit-slope-geom": { labelKey: "editSlopeGeomMode", hintKey: "editSlopeGeomHint" },
  "draw-slope": { labelKey: "drawSlopeMode", hintKey: "drawSlopeHint" },
  "edit-lift-geom": { labelKey: "editLiftGeomMode", hintKey: "editLiftGeomHint" },
  "draw-lift": { labelKey: "drawLiftMode", hintKey: "drawLiftHint" },
  "add-node": { labelKey: "addNodeMode", hintKey: "addNodeHint" },
  "connect-nodes": { labelKey: "connectNodesMode", hintKey: "connectNodesHint" },
  "edit-edge": { labelKey: "editEdgeMode", hintKey: "editEdgeHint" },
};

export type ModeDescriptor = {
  mode: EditorMode;
  icon: ReactNode;
  /** Disabled until the mode is implemented. */
  enabled: boolean;
  /** Some modes only make sense once a slope/lift is selected. */
  requiresSelection?: "slope" | "lift" | "node" | "edge";
};

/**
 * Stable order — top to bottom, grouped by domain. Pick stays first
 * (most-used utility), then selection (the gateway to all edits),
 * then slope edits, lift edits, graph edits.
 */
export const MODE_DESCRIPTORS: ModeDescriptor[] = [
  { mode: "pick", icon: "📍", enabled: true },
  { mode: "select", icon: "👆", enabled: true },
  { mode: "edit-slope-geom", icon: "✎", enabled: true, requiresSelection: "slope" },
  { mode: "draw-slope", icon: "✚", enabled: true },
  { mode: "edit-lift-geom", icon: "🚡", enabled: true, requiresSelection: "lift" },
  { mode: "draw-lift", icon: "🚠", enabled: true },
  { mode: "add-node", icon: "●", enabled: true },
  { mode: "connect-nodes", icon: "─", enabled: false },
  { mode: "edit-edge", icon: "↔", enabled: false, requiresSelection: "edge" },
];

export function ModeToolbar({
  mode,
  onModeChange,
  hasSlope,
  hasLift,
}: {
  mode: EditorMode;
  onModeChange: (mode: EditorMode) => void;
  hasSlope: boolean;
  hasLift: boolean;
}) {
  const t = useTranslations("slopeAuthor");
  return (
    <nav
      aria-label={t("mode")}
      className="no-scrollbar flex w-full flex-none flex-row items-stretch gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 md:h-full md:w-16 md:flex-col md:overflow-x-visible md:border-b-0 md:border-r md:px-0 md:py-3"
    >
      {MODE_DESCRIPTORS.map((d) => {
        const blockedBySelection =
          (d.requiresSelection === "slope" && !hasSlope) ||
          (d.requiresSelection === "lift" && !hasLift);
        const disabled = !d.enabled || blockedBySelection;
        const active = mode === d.mode;
        const i18n = MODE_I18N[d.mode];
        const label = t(i18n.labelKey);
        const hint = t(i18n.hintKey);
        const disabledReason = !d.enabled
          ? t("comingSoon")
          : blockedBySelection
            ? t(
                d.requiresSelection === "slope"
                  ? "selectFirstSlope"
                  : d.requiresSelection === "lift"
                    ? "selectFirstLift"
                    : d.requiresSelection === "node"
                      ? "selectFirstNode"
                      : "selectFirstEdge",
              )
            : null;
        return (
          <button
            key={d.mode}
            type="button"
            disabled={disabled}
            onClick={() => onModeChange(d.mode)}
            className={`flex flex-none flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-[10px] font-semibold transition md:mx-2 md:px-1 md:py-2 ${
              active
                ? "bg-[var(--accent)] text-[var(--accent-ink)]"
                : disabled
                  ? "text-[var(--fg-dim)] opacity-40"
                  : "text-[var(--fg-muted)] hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
            }`}
            title={disabledReason ?? hint}
            aria-label={`${label} — ${disabledReason ?? hint}`}
          >
            <span aria-hidden className="text-base leading-none">
              {d.icon}
            </span>
            <span className="whitespace-nowrap text-[9px] leading-tight tracking-tight">
              {label}
            </span>
          </button>
        );
      })}
    </nav>
  );
}

/** Looks up the descriptor for a mode — used by the persistent
 *  cursor-area badge that tells you what a click is about to do. */
export function modeDescriptor(mode: EditorMode): ModeDescriptor {
  const found = MODE_DESCRIPTORS.find((d) => d.mode === mode);
  if (!found) throw new Error(`unknown mode: ${mode}`);
  return found;
}
