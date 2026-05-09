import { NextResponse } from "next/server";
import {
  signSession,
  buildSetCookieHeader,
} from "@/lib/auth-session";

/**
 * GET /api/auth/github/callback?code=…&state=…
 *
 * 1. Verify the `state` matches the cookie set by /login (CSRF gate).
 * 2. POST code → GitHub for an access token.
 * 3. GET /user with the token to read the user's login.
 * 4. Sign a session cookie + 302 back to /editor.
 *
 * Errors short-circuit to /?error=<reason> so the landing page can
 * surface them without leaking implementation details.
 */

export const runtime = "edge";

const STATE_COOKIE = "osd_oauth_state";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

function clearStateCookieHeader(): string {
  return buildSetCookieHeader({
    name: STATE_COOKIE,
    value: "",
    maxAge: 0,
  });
}

function redirectError(origin: string, reason: string): NextResponse {
  const url = new URL("/", origin);
  url.searchParams.set("error", reason);
  const res = NextResponse.redirect(url.toString(), 302);
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookieState = readCookie(
    request.headers.get("cookie"),
    STATE_COOKIE,
  );

  if (!code || !state || !cookieState || state !== cookieState) {
    return redirectError(origin, "oauth_state_mismatch");
  }

  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return redirectError(origin, "oauth_not_configured");
  }

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: `${origin}/api/auth/github/callback`,
    }),
  });
  if (!tokenRes.ok) return redirectError(origin, "token_exchange_failed");
  const tokenBody = (await tokenRes.json()) as {
    access_token?: string;
    error?: string;
  };
  if (!tokenBody.access_token) {
    return redirectError(origin, tokenBody.error ?? "no_access_token");
  }

  const userRes = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "open-ski-data-editor",
    },
  });
  if (!userRes.ok) return redirectError(origin, "user_lookup_failed");
  const user = (await userRes.json()) as { login?: string };
  if (!user.login) return redirectError(origin, "no_login");

  const cookie = await signSession({
    accessToken: tokenBody.access_token,
    login: user.login,
  });

  const res = NextResponse.redirect(new URL("/", origin).toString(), 302);
  res.headers.append(
    "Set-Cookie",
    buildSetCookieHeader({
      name: cookie.name,
      value: cookie.value,
      expires: cookie.expires,
    }),
  );
  res.headers.append("Set-Cookie", clearStateCookieHeader());
  return res;
}
