import { NextResponse } from "next/server";
import { buildSetCookieHeader } from "@/lib/auth-session";

/**
 * GET /api/auth/github/login
 *
 * Starts the OAuth flow. Generates a per-request `state` nonce,
 * stores it in a short-lived HttpOnly cookie, and 302s the user to
 * GitHub's authorize endpoint with `scope=public_repo`.
 *
 * The callback handler verifies the cookie's `state` matches the
 * one GitHub echoes back, blocking CSRF on the OAuth handshake.
 */

export const runtime = "edge";

const GITHUB_AUTHORIZE = "https://github.com/login/oauth/authorize";
const STATE_COOKIE = "osd_oauth_state";
const STATE_TTL_SECONDS = 10 * 60;

function randomState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function GET(request: Request) {
  const clientId = process.env.GITHUB_CLIENT_ID;
  if (!clientId) {
    return NextResponse.json(
      { error: "GITHUB_CLIENT_ID not configured" },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const origin = `${url.protocol}//${url.host}`;
  const redirectUri = `${origin}/api/auth/github/callback`;
  const state = randomState();

  const authorizeUrl = new URL(GITHUB_AUTHORIZE);
  authorizeUrl.searchParams.set("client_id", clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "public_repo");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("allow_signup", "true");

  const res = NextResponse.redirect(authorizeUrl.toString(), 302);
  res.headers.append(
    "Set-Cookie",
    buildSetCookieHeader({
      name: STATE_COOKIE,
      value: state,
      maxAge: STATE_TTL_SECONDS,
    }),
  );
  return res;
}
