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

const initial: SessionData = {
  user: null,
  accessToken: null,
  status: "loading",
};

export function useSession() {
  const [data, setData] = useState<SessionData>(initial);

  const refresh = useCallback(async () => {
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
