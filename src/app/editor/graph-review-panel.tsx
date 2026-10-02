"use client";

import { useTranslations } from "next-intl";
import type { GraphEdge } from "@/lib/resort-loader";
import type { ReviewItem } from "@/lib/graph-review";

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
      </div>
    </section>
  );
}

export function ReviewListPanel({
  items,
  labels,
  selectedEdgeId,
  onPick,
}: {
  items: ReviewItem[];
  labels: Map<string, string>;
  selectedEdgeId: string | null;
  onPick: (edgeId: string) => void;
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
    </section>
  );
}
