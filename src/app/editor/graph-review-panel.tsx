"use client";

import { useTranslations } from "next-intl";
import type { GraphEdge } from "@/lib/resort-loader";
import type { NearPair, ReviewItem } from "@/lib/graph-review";

/**
 * The reviewer's two panels: the edge that is selected (who it is, where
 * it came from, and the four things you can do to it) and the list of
 * edges still waiting for a decision. Type is 14px and buttons are 44px
 * tall: this is read on a laptop next to a trail map, not squinted at.
 */

const button =
  "min-h-11 rounded-md border px-3 text-sm font-semibold transition disabled:opacity-40";

export function EdgePanel({
  edge,
  label,
  canConfirm,
  canTwoWay,
  onFlip,
  onTwoWay,
  onConfirm,
  onDelete,
  lines,
  onAssign,
  cutArmed,
  onCut,
  canRejoin,
  onRejoin,
  onClose,
}: {
  edge: GraphEdge;
  label: string;
  canConfirm: boolean;
  canTwoWay: boolean;
  onFlip: () => void;
  onTwoWay: () => void;
  onConfirm: () => void;
  onDelete: () => void;
  /** The slopes (or lifts) this piece could belong to. */
  lines: { id: string; name: string }[];
  onAssign: (id: string) => void;
  cutArmed: boolean;
  onCut: () => void;
  canRejoin: boolean;
  onRejoin: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("slopeAuthor");
  const p = edge.provenance;
  const origin =
    p?.source === "suggested" ? t("reviewOriginSuggested")
    : p?.source === "observed" ? t("reviewOriginObserved", { count: p.observed_count ?? 0 })
    : p?.source === "user-edit" ? (p.contributor ? t("reviewOriginUser", { who: p.contributor }) : t("reviewOriginUserAnon"))
    : p?.source === "osm" ? t("reviewOriginOsm", { count: p.observed_count ?? 0 })
    : t("reviewOriginUnknown");
  const kind = edge.kind === "slope" ? t("edgesPanelKindSlope") : edge.kind === "lift" ? t("edgesPanelKindLift") : t("edgesPanelKindTraverse");
  return (
    <section className="rounded-lg border border-[#22d3ee]/40 bg-[#22d3ee]/10 p-3">
      <header className="mb-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-base font-bold text-[var(--fg)]">{label}</p>
          <p className="mt-0.5 text-sm text-[var(--fg-muted)]">
            {kind}
            {edge.length_m ? ` · ${Math.round(edge.length_m)} m` : ""} · {origin}
          </p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("editEdgeStopEditing")} className="min-h-11 px-2 text-lg text-[var(--fg-muted)] hover:text-[var(--fg)]">
          ✕
        </button>
      </header>
      {edge.kind !== "traverse" && (
        <label className="mb-3 block text-sm text-[var(--fg-muted)]">
          {edge.kind === "lift" ? t("reviewBelongsLift") : t("reviewBelongsSlope")}
          <select
            value={(edge.kind === "lift" ? edge.lift_id : edge.slope_id) ?? ""}
            onChange={(e) => onAssign(e.target.value)}
            className="mt-1 block min-h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2 text-sm text-[var(--fg)]"
          >
            <option value="">{t("reviewBelongsNone")}</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>{l.name}</option>
            ))}
          </select>
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <button type="button" onClick={onFlip} className={`${button} border-[var(--border)] text-[var(--fg)] hover:bg-[var(--fg)]/10`}>
          {t("reviewFlip")} <kbd className="ml-1 text-xs opacity-60">F</kbd>
        </button>
        <button type="button" onClick={onTwoWay} disabled={!canTwoWay} className={`${button} border-[var(--border)] text-[var(--fg)] hover:bg-[var(--fg)]/10`}>
          {t("reviewTwoWay")} <kbd className="ml-1 text-xs opacity-60">T</kbd>
        </button>
        <button type="button" onClick={onConfirm} disabled={!canConfirm} className={`${button} border-emerald-600 text-emerald-600 hover:bg-emerald-500/10`}>
          {t("reviewConfirm")} <kbd className="ml-1 text-xs opacity-60">A</kbd>
        </button>
        <button type="button" onClick={onDelete} className={`${button} border-red-600 text-red-600 hover:bg-red-500/10`}>
          {t("reviewDelete")} <kbd className="ml-1 text-xs opacity-60">D</kbd>
        </button>
        <button
          type="button"
          onClick={onCut}
          disabled={edge.kind === "traverse"}
          aria-pressed={cutArmed}
          className={`${button} ${cutArmed ? "border-amber-500 bg-amber-400/20" : "border-[var(--border)]"} text-[var(--fg)] hover:bg-[var(--fg)]/10`}
        >
          {t("reviewCut")} <kbd className="ml-1 text-xs opacity-60">S</kbd>
        </button>
        <button type="button" onClick={onRejoin} disabled={!canRejoin} className={`${button} border-[var(--border)] text-[var(--fg)] hover:bg-[var(--fg)]/10`}>
          {t("reviewRejoin")} <kbd className="ml-1 text-xs opacity-60">J</kbd>
        </button>
      </div>
      {cutArmed && <p className="mt-2 text-sm text-[var(--fg-muted)]">{t("reviewCutHint")}</p>}
    </section>
  );
}

export function ReviewListPanel({
  items,
  labels,
  selectedEdgeId,
  onPick,
  orienting,
  onOrient,
  near,
  nodeLabels,
  onShowNode,
  onWeld,
}: {
  items: ReviewItem[];
  labels: Map<string, string>;
  selectedEdgeId: string | null;
  onPick: (edgeId: string) => void;
  orienting: "idle" | "busy" | "failed" | { flipped: number };
  onOrient: () => void;
  near: NearPair[];
  nodeLabels: Map<string, string>;
  onShowNode: (nodeId: string) => void;
  onWeld: (removeId: string, keepId: string) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const reason = (r: ReviewItem["reason"]) =>
    r === "suggested" ? t("reviewReasonSuggested") : r === "weak" ? t("reviewReasonWeak") : t("reviewReasonDirection");
  return (
    <section className="rounded-lg border border-[var(--border)] p-3">
      <header className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-bold text-[var(--fg)]">{t("reviewTitle", { count: items.length })}</h2>
        <p className="text-xs text-[var(--fg-muted)]">{t("reviewKeys")}</p>
      </header>
      <div className="mb-2 flex items-center gap-2">
        <button
          type="button"
          onClick={onOrient}
          disabled={orienting === "busy"}
          className="min-h-11 rounded-md border border-[var(--border)] px-3 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--fg)]/10 disabled:opacity-40"
        >
          {orienting === "busy" ? t("reviewOrientBusy") : t("reviewOrient")}
        </button>
        <p role="status" className="text-sm text-[var(--fg-muted)]">
          {orienting === "failed" ? t("reviewOrientFailed") : typeof orienting === "object" ? t("reviewOrientDone", { count: orienting.flipped }) : ""}
        </p>
      </div>
      {items.length === 0 ? (
        <p className="text-sm text-[var(--fg-muted)]">{t("reviewEmpty")}</p>
      ) : (
        <ol className="max-h-72 space-y-1 overflow-y-auto">
          {items.map((item, i) => {
            const selected = item.edgeId === selectedEdgeId;
            return (
              <li key={item.edgeId}>
                <button
                  type="button"
                  onClick={() => onPick(item.edgeId)}
                  aria-current={selected}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-md px-2 text-left text-sm ${
                    selected ? "bg-[#22d3ee]/20 text-[var(--fg)]" : "text-[var(--fg-muted)] hover:bg-[var(--fg)]/5"
                  }`}
                >
                  <span className="w-6 flex-none text-right tabular-nums opacity-60">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate">{labels.get(item.edgeId) ?? item.edgeId}</span>
                  <span className="flex-none text-xs opacity-80">{reason(item.reason)}</span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
      {near.length > 0 && (
        <>
          <h3 className="mb-1 mt-3 text-sm font-bold text-[var(--fg)]">{t("reviewNearTitle", { count: near.length })}</h3>
          <ul className="max-h-48 space-y-1 overflow-y-auto">
            {near.map((pair) => (
              <li key={`${pair.a}-${pair.b}`} className="flex min-h-11 items-center gap-2 px-2 text-sm text-[var(--fg-muted)]">
                <button type="button" onClick={() => onShowNode(pair.a)} className="min-h-11 min-w-0 flex-1 truncate text-left hover:text-[var(--fg)]">
                  {nodeLabels.get(pair.a) ?? pair.a} ↔ {nodeLabels.get(pair.b) ?? pair.b}
                </button>
                <span className="flex-none text-xs tabular-nums">{pair.distM} m</span>
                <button
                  type="button"
                  onClick={() => onWeld(pair.a, pair.b)}
                  className="min-h-9 flex-none rounded-md border border-[var(--border)] px-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--fg)]/10"
                >
                  {t("reviewWeld")}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

export type ConnectDraft = {
  kind: "traverse" | "slope" | "lift";
  /** The slope or lift the new piece belongs to; empty for none. */
  lineId: string;
  waypoints: { lat: number; lng: number }[];
};

/** Connect mode's settings: what the line you are about to draw is, and how to bend it. */
export function ConnectDraftPanel({
  draft,
  drawing,
  slopes,
  lifts,
  onChange,
}: {
  draft: ConnectDraft;
  drawing: boolean;
  slopes: { id: string; name: string }[];
  lifts: { id: string; name: string }[];
  onChange: (patch: Partial<ConnectDraft>) => void;
}) {
  const t = useTranslations("slopeAuthor");
  const kinds: ConnectDraft["kind"][] = ["traverse", "slope", "lift"];
  const label = (k: ConnectDraft["kind"]) => (k === "slope" ? t("edgesPanelKindSlope") : k === "lift" ? t("edgesPanelKindLift") : t("edgesPanelKindTraverse"));
  const lines = draft.kind === "slope" ? slopes : draft.kind === "lift" ? lifts : [];
  return (
    <section className="rounded-lg border border-[var(--border)] p-3">
      <h2 className="mb-2 text-sm font-bold text-[var(--fg)]">{t("drawTitle")}</h2>
      <div role="group" aria-label={t("drawTitle")} className="mb-2 flex gap-1">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            aria-pressed={draft.kind === k}
            onClick={() => onChange({ kind: k, lineId: "" })}
            className={`min-h-11 flex-1 rounded-md border px-2 text-sm font-semibold ${
              draft.kind === k ? "border-[#22d3ee] bg-[#22d3ee]/20 text-[var(--fg)]" : "border-[var(--border)] text-[var(--fg-muted)]"
            }`}
          >
            {label(k)}
          </button>
        ))}
      </div>
      {draft.kind !== "traverse" && (
        <select
          value={draft.lineId}
          onChange={(e) => onChange({ lineId: e.target.value })}
          className="mb-2 block min-h-11 w-full rounded-md border border-[var(--border)] bg-[var(--bg-elev)] px-2 text-sm text-[var(--fg)]"
        >
          <option value="">{t("reviewBelongsNone")}</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      )}
      <p className="text-sm text-[var(--fg-muted)]">{drawing ? t("drawHintBend", { count: draft.waypoints.length }) : t("drawHintStart")}</p>
      {draft.waypoints.length > 0 && (
        <button
          type="button"
          onClick={() => onChange({ waypoints: draft.waypoints.slice(0, -1) })}
          className="mt-2 min-h-11 rounded-md border border-[var(--border)] px-3 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--fg)]/10"
        >
          {t("drawUndoBend")}
        </button>
      )}
    </section>
  );
}

/** Shown with a selected node: whether letting go of it joins it to what it lands on. */
export function NodeJoinToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  const t = useTranslations("slopeAuthor");
  return (
    <section className="rounded-lg border border-[var(--border)] p-3">
      <label className="flex min-h-11 items-center gap-3 text-sm font-semibold text-[var(--fg)]">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} className="h-5 w-5" />
        {t("joinToggle")}
      </label>
      <p className="mt-1 text-sm text-[var(--fg-muted)]">{on ? t("joinToggleOnHint") : t("joinToggleOffHint")}</p>
    </section>
  );
}
