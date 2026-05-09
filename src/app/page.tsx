import type { Metadata } from "next";
import { SlopeAuthor2 } from "./editor/editor";

export const metadata: Metadata = {
  title: "Editor | open-ski-data",
  description:
    "Edit a ski resort and submit changes as a pull request to powder-nomad/open-ski-data.",
};

/**
 * Root route — the editor lives at `/`. Anonymous users can browse,
 * load resorts, and explore the map; saving is gated by the
 * `PatchSaver` component (`@/lib/ci-status.tsx`) which renders a
 * "Sign in with GitHub to save" CTA when there's no session.
 *
 * `/editor` still works as a synonym for backward-compatible
 * bookmarks (`src/app/editor/page.tsx` renders the same component).
 */
export default function HomePage() {
  return <SlopeAuthor2 />;
}
