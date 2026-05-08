import Link from "next/link";

/**
 * Landing page for the editor app.
 *
 * Public, unauthenticated. Explains what the editor does and links
 * users to the GitHub OAuth login (`/api/auth/github/login`) before
 * sending them to `/editor`. Sign-in is required for the actual save
 * flow but anonymous users can still load + browse a resort to see
 * what the editor looks like before committing.
 *
 * `?error=<reason>` query param is set by the OAuth callback handler
 * when a sign-in fails (state mismatch, token exchange failure, etc).
 * Surfaces a friendly banner so the user knows what happened instead
 * of silently bouncing back to the landing page.
 */

const ERROR_MESSAGES: Record<string, string> = {
  oauth_state_mismatch:
    "We couldn't verify that sign-in came from you (state mismatch). Try again — usually a stale browser tab.",
  oauth_not_configured:
    "GitHub OAuth isn't configured for this site. The maintainer needs to set GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET.",
  token_exchange_failed:
    "GitHub didn't accept the sign-in code. Try again; if it keeps failing, the OAuth app may be disabled.",
  no_access_token:
    "GitHub didn't return an access token. Try again from the start.",
  user_lookup_failed:
    "GitHub accepted the sign-in but the follow-up user lookup failed. Try again.",
  no_login:
    "GitHub returned an account without a username. That's unusual — try signing in again.",
  access_denied:
    "Sign-in was cancelled. Click 'Sign in with GitHub' to try again.",
};

function friendlyError(raw: string): string {
  return ERROR_MESSAGES[raw] ?? `Sign-in failed: ${raw}`;
}

export default async function LandingPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const params = await searchParams;
  const errorParam = Array.isArray(params.error) ? params.error[0] : params.error;
  const errorMessage = errorParam ? friendlyError(errorParam) : null;

  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <header className="mb-10 space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-[var(--accent-soft)]">
          powder-nomad / open-ski-data
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Help map the world's ski resorts.
        </h1>
        <p className="max-w-2xl text-sm leading-relaxed text-[var(--fg-muted)]">
          Pick a resort. Move a slope, fix a lift name, add a new run, or
          create a brand-new resort. When you save, the editor opens a
          pull request on your GitHub fork and Paul reviews it. No CLI,
          no JSON editing — just the map.
        </p>
      </header>

      {errorMessage && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200"
        >
          <p className="font-semibold">Sign-in failed</p>
          <p className="mt-1 text-red-200/80">{errorMessage}</p>
        </div>
      )}

      <section className="space-y-3">
        <Link
          href="/api/auth/github/login"
          className="inline-flex items-center justify-center gap-2 rounded-full bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--accent-ink)] transition hover:brightness-110"
        >
          <span aria-hidden>↪</span> Sign in with GitHub
        </Link>
        <Link
          href="/editor"
          className="ml-3 inline-flex items-center justify-center gap-2 rounded-full border border-[var(--border)] px-5 py-2.5 text-sm font-semibold text-[var(--fg-muted)] transition hover:bg-[var(--bg-elev)] hover:text-[var(--fg)]"
        >
          Browse the editor first
        </Link>
      </section>

      <footer className="mt-16 space-y-1 text-[11px] text-[var(--fg-dim)]">
        <p>
          Source on{" "}
          <a
            href="https://github.com/powder-nomad/open-ski-data"
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            github.com/powder-nomad/open-ski-data
          </a>{" "}
          (data on <code>main</code>, editor on <code>pages</code>).
        </p>
        <p>
          Schema:{" "}
          <a
            href="https://github.com/powder-nomad/open-ski-data/tree/main/schemas"
            className="underline"
            target="_blank"
            rel="noreferrer"
          >
            JSON Schema in <code>main:schemas/</code>
          </a>
          .
        </p>
      </footer>
    </main>
  );
}
