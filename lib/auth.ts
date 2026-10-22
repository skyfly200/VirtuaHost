import { createHash, timingSafeEqual } from "node:crypto";
import { loginConfigured, verifyToken } from "./session.js";
import type { Role } from "./user-store.js";

// Who may use /api/*. Two ways in, either of which is enough:
//   * a login session token from POST /api/login (the web UI), sent as `Authorization: Bearer <token>`
//   * the shared ACCESS_KEY (for scripts and curl), sent as `x-api-key: <key>` or a Bearer token
//
//   SESSION_SECRET + users          password logins (lib/session.ts, users in lib/user-store.ts)
//   ACCESS_KEY                      optional machine key, at least 16 characters (openssl rand -hex 24); acts as an admin
//   SERVICE_KEYS                    scoped keys for unattended jobs (the hub, a station script), see `serviceKeys()`. Unlike ACCESS_KEY they are
//                                   not admins and only open the routes that name their scope: a leaked one cannot change stations or users.
//   AUTH_DISABLED                   "true" turns the check off, for local development only
//
// With neither configured the API refuses to work instead of silently being open to the internet.
export const MIN_KEY_LENGTH = 16;

/** Who is making a request. Handlers use it to scope data (`username` is the owner id stored on records). */
export interface Principal {
  username: string;
  role: Role;
  via: "login" | "key" | "open" | "service";
  /** For `via: "service"`: what the key may do ("generate", "stations.read", "personas.read", "options.read"). */
  scopes?: readonly string[];
}

export const SERVICE_SCOPES = ["generate", "stations.read", "personas.read", "options.read"] as const;
export type ServiceScope = (typeof SERVICE_SCOPES)[number];

export interface ServiceKey { name: string; runAs?: string; scopes: ServiceScope[]; key: string }

/**
 * SERVICE_KEYS="name:scope+scope:key,other@someone:generate:key2"
 *   name        a label for logs ("glr-hub")
 *   @someone    optional: act as that user, so their saved AI keys (Account card, e.g. an ElevenLabs key) and personas are used. Without it the
 *               key is its own identity, `service:<name>`, and sees only shared personas and the station's/site's keys.
 *   scopes      joined with +, from SERVICE_SCOPES
 *   key         at least 16 characters; may contain colons
 * Malformed entries are ignored (never widened).
 */
export function serviceKeys(env: NodeJS.ProcessEnv = process.env): ServiceKey[] {
  const out: ServiceKey[] = [];
  for (const entry of (env.SERVICE_KEYS ?? "").split(",")) {
    const [who, scopeText, ...rest] = entry.trim().split(":");
    const key = rest.join(":");
    const [name, runAs] = (who ?? "").split("@");
    const scopes = (scopeText ?? "").split("+").filter((x): x is ServiceScope => (SERVICE_SCOPES as readonly string[]).includes(x));
    if (!name || key.length < MIN_KEY_LENGTH || !scopes.length) continue;
    out.push({ name, ...(runAs ? { runAs } : {}), scopes, key });
  }
  return out;
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
  for (const svc of serviceKeys()) {
    if (timingSafeEqual(digest(given), digest(svc.key))) return { username: svc.runAs ?? `service:${svc.name}`, role: "user", via: "service", scopes: svc.scopes };
  }
  if (!loginConfigured()) return null;
  const account = await verifyToken(given);
  return account ? { username: account.username, role: account.role, via: "login" } : null;
}

export type Authorized = { who: Principal; denied?: undefined } | { who?: undefined; denied: Response };

// Resolves the caller, or the error response to send. `admin: true` additionally requires the admin role.
// `scope` names the service-key scope that opens this route; a service key is refused everywhere that does not name one it holds.
export async function authorize(req: Request, options: { admin?: boolean; scope?: ServiceScope } = {}): Promise<Authorized> {
  if (process.env.AUTH_DISABLED === "true") return { who: { username: "local", role: "admin", via: "open" } };

  if (!accessKeyConfigured() && !loginConfigured() && !serviceKeys().length) {
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
  if (who.via === "service" && (options.admin || !options.scope || !who.scopes?.includes(options.scope))) {
    return { denied: Response.json({ error: "This service key is not allowed to do that" }, { status: 403 }) };
  }
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
