"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Octokit } from "@octokit/rest";

/**
 * Client hook for the OAuth session.
 *
 * Strategy: the session cookie is HttpOnly so the client can't read
 * the access token directly. Instead, /api/auth/session does the
 * verify on the server and returns `{ login, accessToken }` to the
 * client, scoped to the same fetch (the response is not cached).
 *
 * The accessToken is held in client memory only — never written to
 * localStorage or sessionStorage. Refreshing the page re-fetches it
 * from the cookie via /api/auth/session.
 *
 * `octokit` is memoized against the access token so consumers can
 * use it stably across renders without re-instantiating Octokit.
 */

type SessionUser = { login: string };

type SessionData = {
  user: SessionUser | null;
  accessToken: string | null;
  status: "loading" | "authenticated" | "anonymous";
};

/**
 * Audit-mode short-circuit. When `NEXT_PUBLIC_AUDIT_MODE === "1"`,
 * skip the GitHub OAuth round-trip entirely and return a synthetic
 * signed-in session. Used by the autonomous visual-audit loop
 * (`scripts/audit.mjs`) which renders the editor for screenshots
 * without a real contributor flow. The sentinel access token will
 * make any accidental GitHub call fail loudly rather than touch
 * production. Production builds never set the flag.
 */
const AUDIT_MODE = process.env.NEXT_PUBLIC_AUDIT_MODE === "1";
const AUDIT_SESSION: SessionData = {
  user: { login: "osd-audit" },
  accessToken: "audit-mode-no-network",
  status: "authenticated",
};

const initial: SessionData = AUDIT_MODE
  ? AUDIT_SESSION
  : { user: null, accessToken: null, status: "loading" };

export function useSession() {
  const [data, setData] = useState<SessionData>(initial);

  const refresh = useCallback(async () => {
    if (AUDIT_MODE) {
      setData(AUDIT_SESSION);
      return;
    }
    try {
      const res = await fetch("/api/auth/session", {
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!res.ok) {
        setData({ user: null, accessToken: null, status: "anonymous" });
        return;
      }
      const body = (await res.json()) as
        | { login: string; accessToken: string }
        | { user: null };
      if ("login" in body) {
        setData({
          user: { login: body.login },
          accessToken: body.accessToken,
          status: "authenticated",
        });
      } else {
        setData({ user: null, accessToken: null, status: "anonymous" });
      }
    } catch {
      setData({ user: null, accessToken: null, status: "anonymous" });
    }
  }, []);

  useEffect(() => {
    if (AUDIT_MODE) return;
    void refresh();
  }, [refresh]);

  const octokit = useMemo(() => {
    if (!data.accessToken) return null;
    return new Octokit({
      auth: data.accessToken,
      userAgent: "open-ski-data-editor/0.1",
    });
  }, [data.accessToken]);

  return {
    user: data.user,
    octokit,
    status: data.status,
    refresh,
  };
}
