import { createHash, timingSafeEqual } from "node:crypto";

// One shared secret in the ACCESS_KEY environment variable protects /api/generate and /api/clips.
// Callers send it as `x-api-key: <key>` or `Authorization: Bearer <key>`.
//
//   ACCESS_KEY      required, at least 16 characters (openssl rand -hex 24)
//   AUTH_DISABLED   "true" turns the check off, for local development only
//
// With no key configured the API refuses to work instead of silently being open to the internet.
export const MIN_KEY_LENGTH = 16;

const digest = (value: string) => createHash("sha256").update(value).digest();

// Returns the error response to send, or null when the request may proceed.
export function checkAuth(req: Request): Response | null {
  if (process.env.AUTH_DISABLED === "true") return null;

  const key = process.env.ACCESS_KEY ?? "";
  if (key.length < MIN_KEY_LENGTH) {
    return Response.json(
      { error: `Server is not configured: set ACCESS_KEY (at least ${MIN_KEY_LENGTH} characters, for example from "openssl rand -hex 24")` },
      { status: 503 },
    );
  }

  const given = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  // Compare fixed-length hashes so the check takes the same time whatever was sent.
  if (!given || !timingSafeEqual(digest(given), digest(key))) {
    return Response.json({ error: "Unauthorized: send the access key as x-api-key or a Bearer token" }, { status: 401 });
  }
  return null;
}
