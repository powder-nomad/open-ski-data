/**
 * Cookie-backed session helpers (edge-runtime safe).
 *
 * Session payload — HMAC-SHA256 signed with `SESSION_SECRET`:
 *
 *   {
 *     accessToken: string,   // GitHub OAuth token (public_repo scope)
 *     login: string,         // GitHub username
 *     expiresAt: number      // epoch ms
 *   }
 *
 * Wire format (set as HttpOnly cookie):
 *
 *   <base64url(JSON.stringify(payload))> "." <hex(hmac-sha256)>
 *
 * Why HMAC and not encryption: the access token is the only sensitive
 * field, and we accept that anyone with the cookie has the token —
 * that's true of any session-bound credential. HMAC prevents
 * tampering (which is what we actually care about; e.g. a malicious
 * proxy can't change the `login` on the cookie). For encryption we'd
 * use AES-GCM via Web Crypto, doable later if the threat model
 * changes (e.g. shared kiosk usage).
 *
 * 7-day TTL — short enough to limit blast radius on a stolen cookie,
 * long enough that contributors don't get logged out mid-edit.
 */

const COOKIE_NAME = "osd_session";
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SessionPayload = {
  accessToken: string;
  login: string;
  expiresAt: number;
};

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error(
      "SESSION_SECRET env var missing or too short (need ≥32 chars)",
    );
  }
  return secret;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(s: string): Uint8Array {
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function hmac(message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bytesToHex(new Uint8Array(sig));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSession(
  data: { accessToken: string; login: string },
): Promise<{ name: string; value: string; expires: Date }> {
  const expiresAt = Date.now() + TTL_MS;
  const payload: SessionPayload = { ...data, expiresAt };
  const enc = new TextEncoder().encode(JSON.stringify(payload));
  const body = bytesToBase64Url(enc);
  const sig = await hmac(body);
  return {
    name: COOKIE_NAME,
    value: `${body}.${sig}`,
    expires: new Date(expiresAt),
  };
}

export async function verifySession(
  cookieValue: string | undefined,
): Promise<SessionPayload | null> {
  if (!cookieValue) return null;
  const dot = cookieValue.lastIndexOf(".");
  if (dot < 0) return null;
  const body = cookieValue.slice(0, dot);
  const sig = cookieValue.slice(dot + 1);

  const expected = await hmac(body);
  if (!timingSafeEqual(sig, expected)) return null;

  let payload: SessionPayload;
  try {
    const decoded = new TextDecoder().decode(base64UrlToBytes(body));
    payload = JSON.parse(decoded) as SessionPayload;
  } catch {
    return null;
  }

  if (typeof payload.expiresAt !== "number" || payload.expiresAt < Date.now()) {
    return null;
  }
  return payload;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;

/**
 * Cookie attribute helper for `Set-Cookie` headers in route handlers.
 * HttpOnly + Secure (Pages serves only HTTPS in prod) + SameSite=Lax
 * so OAuth callback redirects from github.com still send the cookie.
 */
export function buildSetCookieHeader(args: {
  name: string;
  value: string;
  expires?: Date;
  maxAge?: number;
}): string {
  const parts = [
    `${args.name}=${args.value}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ];
  if (args.expires) parts.push(`Expires=${args.expires.toUTCString()}`);
  if (typeof args.maxAge === "number") parts.push(`Max-Age=${args.maxAge}`);
  return parts.join("; ");
}

/** Build a Set-Cookie header that clears the session. */
export function buildClearCookieHeader(): string {
  return buildSetCookieHeader({ name: COOKIE_NAME, value: "", maxAge: 0 });
}
