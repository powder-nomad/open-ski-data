"use client";

import { useEffect, useState } from "react";
import { useSession } from "@/lib/use-session";
import {
  contribute,
  type ContributionResult,
  UPSTREAM_OWNER,
  UPSTREAM_REPO,
} from "@/lib/github-client";

/**
 * `PatchSaver` — public-contributor variant of the v1 component
 * (originally at `ski-platform/.../slope-author/ci-status.tsx`).
 *
 * V1 posted to a server-side `/api/dev/write-resort-patch` route on
 * Paul's VM and polled `/api/dev/check-resort-ci` until GitHub
 * Actions went green, then auto-merged via
 * `/api/dev/merge-resort-branch`. That's the single-author shortcut
 * — fast for Paul, but not safe to expose to the public.
 *
 * V2 (this file) takes the same `PatchBundle` shape so the editor's
 * call site doesn't change, but routes through `contribute()` (see
 * `@/lib/github-client.ts`):
 *
 *   1. ensureFork(user, powder-nomad/open-ski-data)
 *   2. atomic multi-file commit on user's fork
 *   3. open PR back to powder-nomad/open-ski-data:main
 *
 * No CI polling needed — the PR itself is the visible artifact and
 * the existing `reference-data.yml` workflow on `main` runs against
 * it. Paul reviews + manually merges per his existing flow.
 *
 * Sign-in gate: if the user isn't authenticated yet we render a
 * "Sign in with GitHub to save" prompt instead of the save button.
 */

export type PatchBundle = {
  slug: string;
  countryCode: string;
  regionSlug: string;
  files: Record<string, string>;
  message?: string;
};

export type EditSummary = {
  total: number;
  placeEdits: number;
  slopeEdits: number;
  liftEdits: number;
  webcamEdits: number;
  slopeDeletions: number;
  liftDeletions: number;
  webcamDeletions: number;
  newSlopes: number;
  graphAddedNodes: number;
  graphAddedEdges: number;
  graphNodeEdits: number;
  graphEdgeEdits: number;
  graphDeletedNodes: number;
  graphDeletedEdges: number;
};

function formatEditTally(s: EditSummary): string {
  const parts: string[] = [];
  if (s.newSlopes > 0)
    parts.push(`${s.newSlopes} new slope${s.newSlopes !== 1 ? "s" : ""}`);
  if (s.placeEdits > 0)
    parts.push(`${s.placeEdits} place edit${s.placeEdits !== 1 ? "s" : ""}`);
  if (s.slopeEdits > 0)
    parts.push(`${s.slopeEdits} slope edit${s.slopeEdits !== 1 ? "s" : ""}`);
  if (s.liftEdits > 0)
    parts.push(`${s.liftEdits} lift edit${s.liftEdits !== 1 ? "s" : ""}`);
  if (s.webcamEdits > 0)
    parts.push(`${s.webcamEdits} webcam edit${s.webcamEdits !== 1 ? "s" : ""}`);
  if (s.slopeDeletions > 0)
    parts.push(`${s.slopeDeletions} slope removed`);
  if (s.liftDeletions > 0) parts.push(`${s.liftDeletions} lift removed`);
  if (s.webcamDeletions > 0)
    parts.push(`${s.webcamDeletions} webcam removed`);
  if (s.graphAddedNodes > 0)
    parts.push(
      `${s.graphAddedNodes} new graph node${s.graphAddedNodes !== 1 ? "s" : ""}`,
    );
  if (s.graphAddedEdges > 0)
    parts.push(
      `${s.graphAddedEdges} new edge${s.graphAddedEdges !== 1 ? "s" : ""}`,
    );
  if (s.graphNodeEdits > 0)
    parts.push(
      `${s.graphNodeEdits} node edit${s.graphNodeEdits !== 1 ? "s" : ""}`,
    );
  if (s.graphEdgeEdits > 0)
    parts.push(
      `${s.graphEdgeEdits} edge edit${s.graphEdgeEdits !== 1 ? "s" : ""}`,
    );
  if (s.graphDeletedNodes > 0)
    parts.push(`${s.graphDeletedNodes} node removed`);
  if (s.graphDeletedEdges > 0)
    parts.push(`${s.graphDeletedEdges} edge removed`);
  return parts.length === 0 ? "no changes" : parts.join(", ");
}

type SaveState =
  | { kind: "idle" }
  | { kind: "saving"; phase: string }
  | { kind: "saved"; result: ContributionResult }
  | { kind: "error"; message: string };

export function PatchSaver({
  bundle,
  summary,
  disabled,
  onReset,
}: {
  bundle: PatchBundle | null;
  summary?: EditSummary;
  disabled?: boolean;
  onReset?: () => void;
}) {
  const { user, octokit, status } = useSession();
  const [save, setSave] = useState<SaveState>({ kind: "idle" });

  useEffect(() => {
    setSave({ kind: "idle" });
  }, [bundle]);

  async function handleSave() {
    if (!bundle || !user || !octokit) return;
    const tally = summary ? formatEditTally(summary) : "your pending edits";
    if (
      !confirm(
        `Open a pull request on ${UPSTREAM_OWNER}/${UPSTREAM_REPO} with ${tally}?`,
      )
    )
      return;

    setSave({ kind: "saving", phase: "Forking repo…" });
    try {
      setSave({ kind: "saving", phase: "Pushing commit…" });
      const result = await contribute({
        octokit,
        user,
        slug: bundle.slug,
        countryCode: bundle.countryCode,
        regionSlug: bundle.regionSlug,
        files: bundle.files,
        commitMessage: bundle.message,
        prTitle:
          bundle.message ??
          `Edit ${bundle.countryCode}/${bundle.regionSlug}/${bundle.slug}`,
        prBody: summary
          ? `Submitted via the open-ski-data web editor.\n\nSummary: ${formatEditTally(
              summary,
            )}`
          : undefined,
      });
      setSave({ kind: "saved", result });
    } catch (err) {
      setSave({
        kind: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const hasEdits = summary ? summary.total > 0 : true;
  const canSave =
    save.kind !== "saving" &&
    bundle !== null &&
    !disabled &&
    hasEdits &&
    user !== null;

  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elev)]/40 p-3 text-xs">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]/80">
          Save as PR
        </p>
        {save.kind === "saved" && (
          <button
            type="button"
            onClick={() => {
              setSave({ kind: "idle" });
              onReset?.();
            }}
            className="text-[10px] text-[var(--fg-muted)] underline hover:text-[var(--fg)]"
          >
            reset
          </button>
        )}
      </div>

      {status === "loading" && (
        <p className="text-[var(--fg-muted)]">Checking session…</p>
      )}
      {status !== "loading" && !user && (
        <a
          href="/api/auth/github/login"
          className="block w-full rounded-full bg-[var(--accent)] px-3 py-2 text-center text-xs font-semibold text-[var(--accent-ink)]"
        >
          Sign in with GitHub to save
        </a>
      )}

      {user && save.kind === "idle" && (
        <>
          {summary && summary.total > 0 && (
            <p className="text-[11px] text-[var(--fg-muted)]">
              Pending: {formatEditTally(summary)}
            </p>
          )}
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="w-full rounded-full bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[var(--accent-ink)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {!bundle
              ? "Pick a resort first"
              : !hasEdits
              ? "No edits yet"
              : `Open PR with ${summary ? summary.total : ""} edit${
                  summary && summary.total !== 1 ? "s" : ""
                }`}
          </button>
          <p className="text-[10px] text-[var(--fg-dim)]">
            Signed in as <code>{user.login}</code>. The editor will fork
            the repo to your account on first save.
          </p>
        </>
      )}

      {save.kind === "saving" && (
        <p className="text-[var(--fg-muted)]">{save.phase}</p>
      )}

      {save.kind === "error" && (
        <p className="rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
          Save failed: {save.message}
          <button
            type="button"
            onClick={() => setSave({ kind: "idle" })}
            className="ml-2 underline"
          >
            retry
          </button>
        </p>
      )}

      {save.kind === "saved" && (
        <div className="space-y-1">
          <div className="rounded bg-[#22c55e]/15 px-2 py-2 text-[11px] text-[#86efac]">
            ✓ PR opened —{" "}
            <a
              href={save.result.prUrl}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              #{save.result.prNumber}
            </a>
          </div>
          <p className="text-[11px] text-[var(--fg-muted)]">
            Branch{" "}
            <a
              href={save.result.forkBranchUrl}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--accent-soft)] underline"
            >
              {save.result.forkOwner}:{save.result.branchName}
            </a>
          </p>
          <p className="text-[10px] text-[var(--fg-muted)] tabular-nums">
            commit {save.result.commitSha.slice(0, 7)}
          </p>
        </div>
      )}
    </div>
  );
}
