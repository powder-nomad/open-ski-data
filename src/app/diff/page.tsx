import { Suspense } from "react";
import { DiffView } from "./diff-view";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "PR diff | open-ski-data",
  description:
    "Visualise a pull request's graph changes on the live map before merging.",
};

/**
 * Public route — no OAuth gate. The diff viewer only reads from the
 * public powder-nomad/open-ski-data repo via unauthenticated GitHub
 * API and raw.githubusercontent.com.
 *
 * Wrapped in Suspense because DiffView calls useSearchParams(), which
 * requires a Suspense boundary on the Next.js App Router.
 */
export default function DiffPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-[var(--bg-surface)]">
          <p className="text-sm text-[var(--fg-muted)]">Loading…</p>
        </div>
      }
    >
      <DiffView />
    </Suspense>
  );
}
