import { NextResponse } from "next/server";
import {
  verifySession,
  SESSION_COOKIE_NAME,
} from "@/lib/auth-session";

/**
 * GET /api/auth/session
 *
 * Returns the current user + access token if the session cookie
 * verifies. Used by `useSession` on the client to bootstrap the
 * Octokit instance.
 *
 * The access token is exposed to the same-origin client (so the
 * editor can call GitHub directly via Octokit). The cookie itself
 * stays HttpOnly — the token never lives in localStorage and is
 * only readable through this server-verified endpoint.
 */

export const runtime = "edge";

function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

export async function GET(request: Request) {
  const cookieValue = readCookie(
    request.headers.get("cookie"),
    SESSION_COOKIE_NAME,
  );
  const session = await verifySession(cookieValue);
  if (!session) {
    return NextResponse.json({ user: null }, { status: 401 });
  }
  return NextResponse.json(
    { login: session.login, accessToken: session.accessToken },
    {
      headers: {
        "Cache-Control": "no-store, private",
      },
    },
  );
}
