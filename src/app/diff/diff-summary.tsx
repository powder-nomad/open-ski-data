"use client";

/**
 * Right-panel summary for the diff viewer.
 *
 * Shows the changeset grouped by entity kind for the selected resort.
 * Rows are click-targets that call back to pan/zoom the map.
 * Non-graph files (place.json, webcams.json) render as collapsible
 * JSON field-level diffs.
 */

import { useState } from "react";
import type { ResortDiff } from "./use-pr-diff";
import type { NodeDiff, EdgeDiff } from "@/lib/diff-graph";
import type { SlopeDiff, LiftDiff, WebcamDiff } from "@/lib/diff-sidecar";

type DiffKind = "added" | "removed" | "modified";

const DOT_COLOR: Record<DiffKind, string> = {
  added: "#22c55e",
  removed: "#ef4444",
  modified: "#eab308",
};

const LABEL: Record<DiffKind, string> = {
  added: "+",
  removed: "−",
  modified: "±",
};

function DotBadge({ kind }: { kind: DiffKind }) {
  return (
    <span
      className="inline-block w-2 h-2 rounded-full flex-shrink-0"
      style={{ background: DOT_COLOR[kind] }}
    />
  );
}

function CountRow({
  label,
  added,
  removed,
  modified,
  onClick,
}: {
  label: string;
  added: number;
  removed: number;
  modified: number;
  onClick?: () => void;
}) {
  const total = added + removed + modified;
  if (total === 0) {
    return (
      <div className="flex items-center gap-2 py-0.5 text-xs text-[var(--fg-dim)]">
        <span className="inline-block w-2 h-2 rounded-full flex-shrink-0 bg-[var(--fg-dim)] opacity-30" />
        <span className="flex-1">{label}</span>
        <span>±0</span>
      </div>
    );
  }
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-2 py-0.5 text-xs text-[var(--fg)] hover:text-[var(--accent)] transition-colors text-left"
    >
      {removed > 0 ? (
        <DotBadge kind="removed" />
      ) : modified > 0 ? (
        <DotBadge kind="modified" />
      ) : (
        <DotBadge kind="added" />
      )}
      <span className="flex-1">{label}</span>
      <span className="font-mono tabular-nums">
        {added > 0 && <span className="text-[#22c55e]">+{added} </span>}
        {removed > 0 && <span className="text-[#ef4444]">−{removed} </span>}
        {modified > 0 && <span className="text-[#eab308]">±{modified}</span>}
      </span>
    </button>
  );
}

function counts<T extends { kind: DiffKind }>(arr: T[]) {
  return {
    added: arr.filter((x) => x.kind === "added").length,
    removed: arr.filter((x) => x.kind === "removed").length,
    modified: arr.filter((x) => x.kind === "modified").length,
  };
}

function JsonDiffBlock({
  label,
  fields,
  before,
  after,
}: {
  label: string;
  fields: string[];
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  if (fields.length === 0) return null;

  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-1.5 text-xs text-[var(--fg-muted)] hover:text-[var(--fg)] transition-colors text-left"
      >
        <span className="font-mono">{open ? "▾" : "▸"}</span>
        <span>{label}</span>
        <span className="ml-auto text-[#eab308]">±{fields.length} field{fields.length > 1 ? "s" : ""}</span>
      </button>
      {open && (
        <div className="mt-1 space-y-1">
          {fields.map((f) => (
            <div key={f} className="text-xs font-mono pl-3">
              <span className="text-[var(--fg-dim)]">{f}:</span>
              {before && (
                <div className="pl-2 text-[#ef4444] opacity-80">
                  − {JSON.stringify((before as Record<string, unknown>)[f])}
                </div>
              )}
              {after && (
                <div className="pl-2 text-[#22c55e]">
                  + {JSON.stringify((after as Record<string, unknown>)[f])}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffSummary({
  resort,
  allResorts,
  selectedResort,
  onSelectResort,
  onFocusNodes,
  onFocusEdges,
  onFocusSlopes,
  onFocusLifts,
}: {
  resort: ResortDiff | null;
  allResorts: ResortDiff[];
  selectedResort: string | null;
  onSelectResort: (slug: string) => void;
  onFocusNodes: (ids: string[]) => void;
  onFocusEdges: (ids: string[]) => void;
  onFocusSlopes: (ids: string[]) => void;
  onFocusLifts: (ids: string[]) => void;
}) {
  if (!resort) {
    return (
      <div className="text-xs text-[var(--fg-muted)] px-1">
        No resort diff loaded.
      </div>
    );
  }

  const { graphDiff, sidecarDiff } = resort;

  const nodeCounts = counts<NodeDiff>(graphDiff.nodes);
  const edgeCounts = counts<EdgeDiff>(graphDiff.edges);
  const slopeCounts = counts<SlopeDiff>(sidecarDiff.slopes);
  const liftCounts = counts<LiftDiff>(sidecarDiff.lifts);
  const webcamCounts = counts<WebcamDiff>(sidecarDiff.webcams);

  const hasGeomChanges = graphDiff.hasGeometryChanges;
  const allNodeIds = graphDiff.nodes.map((n) => n.id);
  const allEdgeIds = graphDiff.edges.map((e) => e.id);
  const allSlopeIds = sidecarDiff.slopes.map((s) => s.id);
  const allLiftIds = sidecarDiff.lifts.map((l) => l.id);

  return (
    <div className="flex flex-col gap-3 text-xs">
      {/* Resort switcher */}
      {allResorts.length > 1 && (
        <div>
          <div className="text-[10px] font-semibold text-[var(--fg-muted)] mb-1">Resort</div>
          <select
            value={selectedResort ?? ""}
            onChange={(e) => onSelectResort(e.target.value)}
            className="w-full rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1 text-xs text-[var(--fg)]"
          >
            {allResorts.map((r) => (
              <option key={r.slug} value={r.slug}>
                {r.slug}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* No-geometry banner */}
      {!hasGeomChanges && graphDiff.edges.length > 0 && (
        <div className="rounded-xl px-3 py-2 text-xs font-medium text-[#4ade80] bg-[#052e16]/60 border border-[#15803d]/40">
          No geometry changes — algorithmic only
        </div>
      )}

      {/* Graph section */}
      <div>
        <div className="text-[10px] font-semibold text-[var(--fg-muted)] mb-1">{resort.slug} — graph</div>
        <CountRow
          label="graph-node"
          {...nodeCounts}
          onClick={() => onFocusNodes(allNodeIds)}
        />
        <CountRow
          label="graph-edge"
          {...edgeCounts}
          onClick={() => onFocusEdges(allEdgeIds)}
        />
      </div>

      {/* Slope/lift section */}
      <div>
        <div className="text-[10px] font-semibold text-[var(--fg-muted)] mb-1">slopes & lifts</div>
        <CountRow
          label="slope"
          {...slopeCounts}
          onClick={() => onFocusSlopes(allSlopeIds)}
        />
        <CountRow
          label="lift"
          {...liftCounts}
          onClick={() => onFocusLifts(allLiftIds)}
        />
      </div>

      {/* Webcams */}
      <div>
        <div className="text-[10px] font-semibold text-[var(--fg-muted)] mb-1">webcams</div>
        <CountRow label="webcam" {...webcamCounts} />
        {sidecarDiff.webcams.filter((w) => w.kind === "modified").map((w) => (
          <JsonDiffBlock
            key={w.label}
            label={w.label}
            fields={Object.keys(w.after ?? {}).filter(
              (k) =>
                JSON.stringify((w.before as Record<string, unknown> | undefined)?.[k]) !==
                JSON.stringify((w.after as Record<string, unknown> | undefined)?.[k]),
            )}
            before={w.before as Record<string, unknown> | undefined}
            after={w.after as Record<string, unknown> | undefined}
          />
        ))}
      </div>

      {/* Place */}
      <div>
        <div className="text-[10px] font-semibold text-[var(--fg-muted)] mb-1">place.json</div>
        {sidecarDiff.place.hasChanges ? (
          <JsonDiffBlock
            label="place"
            fields={sidecarDiff.place.changedFields}
            before={sidecarDiff.place.before as Record<string, unknown> | undefined}
            after={sidecarDiff.place.after as Record<string, unknown> | undefined}
          />
        ) : (
          <div className="text-[var(--fg-dim)] py-0.5">±0</div>
        )}
      </div>
    </div>
  );
}
