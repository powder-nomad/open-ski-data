"use client";

import { useState } from "react";
import { useSession } from "@/lib/use-session";

/**
 * Floating session chip — top-right, on every page via the root
 * layout. Three states:
 *
 *   - loading      → small text indicator (no flicker before the
 *                    cookie probe lands; ~50ms in dev, single edge
 *                    fetch in prod).
 *   - anonymous    → "Sign in with GitHub" button (anchor to
 *                    /api/auth/github/login).
 *   - authenticated→ avatar (GitHub's CDN url derived from login) +
 *                    username + a popover with "Sign out".
 *
 * Why a popover (not just a sign-out button inline): we want the
 * chip compact when authed so it doesn't compete with the editor's
 * own controls; the popover affordance keeps sign-out out of the
 * way until needed.
 *
 * The chip is `position: fixed` so it overlays everything but never
 * occupies grid space — important because the editor lays the map
 * out edge-to-edge.
 */
export function SessionHeader() {
  const { user, status, refresh } = useSession();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
      });
      await refresh();
      setMenuOpen(false);
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <div className="pointer-events-none fixed right-3 top-3 z-50 flex items-center gap-2">
      {status === "loading" && (
        <span className="pointer-events-auto rounded-full border border-[var(--border)] bg-[var(--bg-elev)]/80 px-3 py-1 text-[11px] text-[var(--fg-dim)] backdrop-blur">
          …
        </span>
      )}

      {status === "anonymous" && (
        <a
          href="/api/auth/github/login"
          className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-[var(--accent)] px-3 py-1.5 text-[11px] font-semibold text-[var(--accent-ink)] shadow-md transition hover:brightness-110"
          aria-label="Sign in with GitHub"
        >
          <span aria-hidden>↪</span> Sign in
        </a>
      )}

      {status === "authenticated" && user && (
        <div className="pointer-events-auto relative">
          <button
            type="button"
            onClick={() => setMenuOpen((v) => !v)}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--bg-elev)]/85 px-2 py-1 text-[11px] font-semibold text-[var(--fg)] shadow-md backdrop-blur transition hover:bg-[var(--bg-elev)]"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Signed in as ${user.login} — open menu`}
          >
            {/*
             * GitHub's avatar redirect is unauthenticated and stable,
             * so we can lean on it directly without a backend hop.
             * `size=64` keeps the bundle weight irrelevant.
             */}
            <img
              src={`https://github.com/${encodeURIComponent(user.login)}.png?size=64`}
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 rounded-full bg-[var(--bg-surface)]"
            />
            <span className="max-w-[14ch] truncate">{user.login}</span>
            <span aria-hidden className="text-[var(--fg-muted)]">▾</span>
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 min-w-[180px] rounded-lg border border-[var(--border)] bg-[var(--bg-elev)] p-1 text-[11px] text-[var(--fg)] shadow-xl"
            >
              <a
                href={`https://github.com/${encodeURIComponent(user.login)}`}
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                className="block w-full rounded-md px-3 py-1.5 text-left hover:bg-[var(--bg-elev-strong)]"
                onClick={() => setMenuOpen(false)}
              >
                View GitHub profile ↗
              </a>
              <a
                href={`https://github.com/${encodeURIComponent(user.login)}/open-ski-data`}
                target="_blank"
                rel="noreferrer"
                role="menuitem"
                className="block w-full rounded-md px-3 py-1.5 text-left hover:bg-[var(--bg-elev-strong)]"
                onClick={() => setMenuOpen(false)}
              >
                View your fork ↗
              </a>
              <div role="separator" className="my-1 border-t border-[var(--border)]" />
              <button
                type="button"
                onClick={handleSignOut}
                disabled={signingOut}
                role="menuitem"
                className="block w-full rounded-md px-3 py-1.5 text-left text-[var(--fg-muted)] hover:bg-[var(--bg-elev-strong)] hover:text-[var(--fg)] disabled:opacity-50"
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
