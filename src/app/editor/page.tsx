import type { Metadata } from "next";
import { SlopeAuthor2 } from "./editor";

export const metadata: Metadata = {
  title: "Editor | open-ski-data",
  description:
    "Edit a ski resort and submit changes as a pull request to powder-nomad/open-ski-data.",
  robots: { index: false, follow: false },
};

/**
 * Editor route. The actual UI lives in `./editor.tsx`, ported from
 * `ski-platform/apps/web/app/dev/slope-author-2/editor.tsx`. The
 * editor renders a Google Maps view with mode toolbar + slope/lift
 * panels; saving flows through the user's GitHub OAuth token via
 * `@/lib/github-client.contribute()`.
 */
export default function EditorPage() {
  return <SlopeAuthor2 />;
}
