import type { Metadata } from "next";
import { SessionHeader } from "@/components/SessionHeader";
import "./globals.css";

export const metadata: Metadata = {
  title: "open-ski-data editor",
  description:
    "Browser-based editor for the powder-nomad/open-ski-data registry. Sign in with GitHub, edit a resort, submit a PR.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg-surface)] text-[var(--fg)] antialiased">
        <SessionHeader />
        {children}
      </body>
    </html>
  );
}
