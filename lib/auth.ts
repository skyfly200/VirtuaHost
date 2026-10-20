import { createHash, timingSafeEqual } from "node:crypto";
import { loginConfigured, verifyToken } from "./session.js";

// Who may use /api/*. Two ways in, either of which is enough:
//   * a login session token from POST /api/login (the web UI), sent as `Authorization: Bearer <token>`
//   * the shared ACCESS_KEY (for scripts and curl), sent as `x-api-key: <key>` or a Bearer token
//
//   LOGIN_USERS + SESSION_SECRET   password logins (lib/session.ts)
//   ACCESS_KEY                     optional machine key, at least 16 characters (openssl rand -hex 24)
//   AUTH_DISABLED                  "true" turns the check off, for local development only
//
// With neither configured the API refuses to work instead of silently being open to the internet.
export const MIN_KEY_LENGTH = 16;

const digest = (value: string) => createHash("sha256").update(value).digest();

export function accessKeyConfigured(): boolean {
  return (process.env.ACCESS_KEY ?? "").length >= MIN_KEY_LENGTH;
}

export function credentialFrom(req: Request): string {
  return req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

export function isAuthorized(req: Request): boolean {
  const given = credentialFrom(req);
  if (!given) return false;
  // Compare fixed-length hashes so the check takes the same time whatever was sent.
  if (accessKeyConfigured() && timingSafeEqual(digest(given), digest(process.env.ACCESS_KEY ?? ""))) return true;
  return loginConfigured() && verifyToken(given) !== null;
}

// Returns the error response to send, or null when the request may proceed.
export function checkAuth(req: Request): Response | null {
  if (process.env.AUTH_DISABLED === "true") return null;

  if (!accessKeyConfigured() && !loginConfigured()) {
    return Response.json(
      {
        error:
          `Server is not configured: set LOGIN_USERS and SESSION_SECRET (password logins), or ACCESS_KEY (at least ${MIN_KEY_LENGTH} characters), ` +
          'for example from "openssl rand -hex 24"',
      },
      { status: 503 },
    );
  }
  if (!isAuthorized(req)) {
    return Response.json({ error: "Unauthorized: sign in, or send the access key as x-api-key or a Bearer token" }, { status: 401 });
  }
  return null;
}
