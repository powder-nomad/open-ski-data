import type { Metadata } from "next";
import { GraphEditor } from "./graph/graph-editor";

export const metadata: Metadata = {
  title: "Editor | open-ski-data",
  description:
    "Edit a ski resort's slopes and lifts and submit changes as a pull request to powder-nomad/open-ski-data.",
};

/**
 * Root route: the slope and lift graph editor (`./graph/graph-editor.tsx`).
 * Anonymous users can browse and edit; saving is gated by `PatchSaver`
 * (`@/lib/ci-status.tsx`), which asks for a GitHub sign-in.
 *
 * The earlier all-purpose editor (place details, webcams, raw nodes and
 * edges) is still at `/editor`.
 */
export default function HomePage() {
  return <GraphEditor />;
}
