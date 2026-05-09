import type { Metadata } from "next";
import { SessionHeader } from "@/components/SessionHeader";
import { LocaleProvider } from "@/lib/next-intl-stub";
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
  // <html lang> starts as "en" for SSR; LocaleProvider's useEffect
  // updates document.documentElement.lang to the navigator-detected
  // locale on hydration. See `src/lib/next-intl-stub.tsx` for the
  // hydration-safe locale strategy and the next-on-pages constraint
  // that blocks server-side `headers()`.
  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--bg-surface)] text-[var(--fg)] antialiased">
        <LocaleProvider>
          <SessionHeader />
          {children}
        </LocaleProvider>
      </body>
    </html>
  );
}
