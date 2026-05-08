import { NextResponse } from "next/server";
import { buildClearCookieHeader } from "@/lib/auth-session";

/**
 * POST /api/auth/logout
 *
 * Clears the session cookie. Idempotent — calling on an already-
 * anonymous session is harmless. Returns `{ ok: true }`.
 */

export const runtime = "edge";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.append("Set-Cookie", buildClearCookieHeader());
  return res;
}
