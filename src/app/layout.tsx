import type { Metadata } from "next";
import { SessionHeader } from "@/components/SessionHeader";
import { LocaleProvider } from "@/lib/next-intl-stub";
import { ColorSchemeProvider, ThemeScript } from "@/lib/color-scheme";
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
      <head>
        {/* Reads localStorage before paint → zero flash of wrong color scheme */}
        <ThemeScript />
      </head>
      <body className="min-h-screen bg-[var(--bg-surface)] text-[var(--fg)] antialiased">
        <ColorSchemeProvider>
          <LocaleProvider>
            <SessionHeader />
            {children}
          </LocaleProvider>
        </ColorSchemeProvider>
      </body>
    </html>
  );
}
