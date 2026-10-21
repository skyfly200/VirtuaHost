import { createHmac, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";
import { getUser, USERNAME, type Role } from "./user-store.js";

// Password logins for the web UI.
//
//   SESSION_SECRET  a random string of 32+ characters that signs session tokens (openssl rand -hex 32)
//   SESSION_HOURS   how long a login lasts (default 12)
//   LOGIN_USERS     optional bootstrap admins, "alice:scrypt.<salt>.<hash>,bob:..." (make a hash with `npm run hash-password`).
//                   They are always admins and cannot be edited in the UI. Everyone else is created by an admin in the
//                   Users tab and lives in the database (lib/user-store.ts).
//
// A token is "v1.<payload>.<signature>" signed with HMAC-SHA256. It only says who signed in; the account is looked up on every
// request, so disabling or deleting a user, or changing their role, takes effect immediately. Changing SESSION_SECRET signs
// everyone out.
export const MIN_SECRET_LENGTH = 32;

export interface Account {
  username: string;
  role: Role;
  source: "env" | "database";
  passwordHash: string;
}

export function parseUsers(raw: string | undefined = process.env.LOGIN_USERS): Map<string, string> {
  const users = new Map<string, string>();
  for (const entry of (raw ?? "").split(",")) {
    const at = entry.indexOf(":");
    if (at < 1) continue;
    const name = entry.slice(0, at).trim();
    const hash = entry.slice(at + 1).trim();
    if (USERNAME.test(name) && hash) users.set(name, hash);
  }
  return users;
}

const secret = () => process.env.SESSION_SECRET ?? "";
/** Password sign-in is available once the signing secret is set. Whether anyone can actually sign in depends on the users. */
export const loginConfigured = (): boolean => secret().length >= MIN_SECRET_LENGTH;

export async function findAccount(username: string): Promise<Account | null> {
  const name = username.trim();
  const envHash = parseUsers().get(name);
  if (envHash) return { username: name, role: "admin", source: "env", passwordHash: envHash };
  const user = await getUser(name);
  if (!user || user.disabled) return null;
  return { username: user.username, role: user.role, source: "database", passwordHash: user.passwordHash };
}

// A stand-in hash, so an unknown username costs the same time as a wrong password.
const DUMMY = hashPassword("not-a-real-password");

/** The account when the password is right, otherwise null. */
export async function checkPassword(username: string, password: string): Promise<Account | null> {
  const account = await findAccount(username);
  const ok = verifyPassword(password, account?.passwordHash ?? DUMMY);
  return account && ok ? account : null;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function issueToken(username: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const hours = Number(process.env.SESSION_HOURS) > 0 ? Number(process.env.SESSION_HOURS) : 12;
  const expiresAt = now + hours * 3600_000;
  const payload = b64(JSON.stringify({ sub: username, exp: expiresAt }));
  return { token: `v1.${payload}.${b64(sign(`v1.${payload}`))}`, expiresAt };
}

// The username in a validly signed, unexpired token, otherwise null. Does not check that the account still exists.
export function readToken(token: string, now: number = Date.now()): string | null {
  if (!loginConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const given = Buffer.from(parts[2], "base64url");
  const wanted = sign(`v1.${parts[1]}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { sub?: string; exp?: number };
    return typeof sub === "string" && typeof exp === "number" && exp > now ? sub : null;
  } catch {
    return null;
  }
}

// The account for a valid token whose user still exists and is not disabled.
export async function verifyToken(token: string, now: number = Date.now()): Promise<Account | null> {
  const sub = readToken(token, now);
  return sub ? findAccount(sub) : null;
}
