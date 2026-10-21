import { createHash, timingSafeEqual } from "node:crypto";
import { loginConfigured, verifyToken } from "./session.js";
import type { Role } from "./user-store.js";

// Who may use /api/*. Two ways in, either of which is enough:
//   * a login session token from POST /api/login (the web UI), sent as `Authorization: Bearer <token>`
//   * the shared ACCESS_KEY (for scripts and curl), sent as `x-api-key: <key>` or a Bearer token
//
//   SESSION_SECRET + users          password logins (lib/session.ts, users in lib/user-store.ts)
//   ACCESS_KEY                      optional machine key, at least 16 characters (openssl rand -hex 24); acts as an admin
//   AUTH_DISABLED                   "true" turns the check off, for local development only
//
// With neither configured the API refuses to work instead of silently being open to the internet.
export const MIN_KEY_LENGTH = 16;

/** Who is making a request. Handlers use it to scope data (`username` is the owner id stored on records). */
export interface Principal {
  username: string;
  role: Role;
  via: "login" | "key" | "open";
}

const digest = (value: string) => createHash("sha256").update(value).digest();

export function accessKeyConfigured(): boolean {
  return (process.env.ACCESS_KEY ?? "").length >= MIN_KEY_LENGTH;
}

export function credentialFrom(req: Request): string {
  return req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
}

export async function principalOf(req: Request): Promise<Principal | null> {
  const given = credentialFrom(req);
  if (!given) return null;
  // Compare fixed-length hashes so the check takes the same time whatever was sent.
  if (accessKeyConfigured() && timingSafeEqual(digest(given), digest(process.env.ACCESS_KEY ?? ""))) return { username: "api-key", role: "admin", via: "key" };
  if (!loginConfigured()) return null;
  const account = await verifyToken(given);
  return account ? { username: account.username, role: account.role, via: "login" } : null;
}

export type Authorized = { who: Principal; denied?: undefined } | { who?: undefined; denied: Response };

// Resolves the caller, or the error response to send. `admin: true` additionally requires the admin role.
export async function authorize(req: Request, options: { admin?: boolean } = {}): Promise<Authorized> {
  if (process.env.AUTH_DISABLED === "true") return { who: { username: "local", role: "admin", via: "open" } };

  if (!accessKeyConfigured() && !loginConfigured()) {
    return {
      denied: Response.json(
        {
          error:
            `Server is not configured: set SESSION_SECRET (32+ characters) for password logins, or ACCESS_KEY (at least ${MIN_KEY_LENGTH} characters), ` +
            'for example from "openssl rand -hex 24"',
        },
        { status: 503 },
      ),
    };
  }
  const who = await principalOf(req);
  if (!who) return { denied: Response.json({ error: "Unauthorized: sign in, or send the access key as x-api-key or a Bearer token" }, { status: 401 }) };
  if (options.admin && who.role !== "admin") return { denied: Response.json({ error: "Only an admin can do that" }, { status: 403 }) };
  return { who };
}

// Returns the error response to send, or null when the request may proceed.
export async function checkAuth(req: Request): Promise<Response | null> {
  return (await authorize(req)).denied ?? null;
}

/** The owner id to stamp on a new record: the username, or nothing for admins and the machine key (their records are the station's, shared with all). */
export const ownerFor = (who: Principal): string | undefined => (who.role === "admin" ? undefined : who.username);

/** Can this caller change a record? Admins can change anything; others only what they own (unowned records are shared, read-only). */
export const canModify = (who: Principal, ownerId: string | undefined): boolean => who.role === "admin" || (ownerId !== undefined && ownerId === who.username);
/** Can this caller see a record? Admins see everything; others see their own and unowned (shared) ones. */
export const canView = (who: Principal, ownerId: string | undefined): boolean => who.role === "admin" || ownerId === undefined || ownerId === who.username;
