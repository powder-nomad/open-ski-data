import type { Metadata } from "next";
import { GraphEditor } from "./graph-editor";

export const metadata: Metadata = {
  title: "Slopes and lifts | open-ski-data",
  description: "Edit a resort's slopes and lifts as one connected graph and send the change as a pull request.",
  robots: { index: false, follow: false },
};

export default function GraphEditorPage() {
  return <GraphEditor />;
}
