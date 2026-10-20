import { createHmac, timingSafeEqual } from "node:crypto";
import { hashPassword, verifyPassword } from "./passwords.js";

// Password logins for the web UI.
//
//   LOGIN_USERS     "alice:scrypt.<salt>.<hash>,bob:scrypt.<salt>.<hash>"  (make a hash with `npm run hash-password`)
//   SESSION_SECRET  a random string of 32+ characters that signs session tokens (openssl rand -hex 32)
//   SESSION_HOURS   how long a login lasts (default 12)
//
// A token is "v1.<payload>.<signature>" signed with HMAC-SHA256; nothing is stored on the server, so it works on serverless
// functions. Changing SESSION_SECRET signs everyone out.
export const MIN_SECRET_LENGTH = 32;
const USERNAME = /^[A-Za-z0-9_.@-]{1,40}$/;

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
export const loginConfigured = (): boolean => parseUsers().size > 0 && secret().length >= MIN_SECRET_LENGTH;

// A stand-in hash, so an unknown username costs the same time as a wrong password.
const DUMMY = hashPassword("not-a-real-password");

export function checkPassword(username: string, password: string): boolean {
  const stored = parseUsers().get(username);
  const ok = verifyPassword(password, stored ?? DUMMY);
  return Boolean(stored) && ok;
}

const b64 = (data: Buffer | string) => Buffer.from(data).toString("base64url");
const sign = (data: string) => createHmac("sha256", secret()).update(data).digest();

export function issueToken(username: string, now: number = Date.now()): { token: string; expiresAt: number } {
  const hours = Number(process.env.SESSION_HOURS) > 0 ? Number(process.env.SESSION_HOURS) : 12;
  const expiresAt = now + hours * 3600_000;
  const payload = b64(JSON.stringify({ sub: username, exp: expiresAt }));
  return { token: `v1.${payload}.${b64(sign(`v1.${payload}`))}`, expiresAt };
}

// Returns the username for a valid, unexpired token, otherwise null.
export function verifyToken(token: string, now: number = Date.now()): string | null {
  if (!loginConfigured()) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return null;
  const given = Buffer.from(parts[2], "base64url");
  const wanted = sign(`v1.${parts[1]}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { sub?: string; exp?: number };
    // The user must still exist: removing someone from LOGIN_USERS ends their session.
    return typeof sub === "string" && typeof exp === "number" && exp > now && parseUsers().has(sub) ? sub : null;
  } catch {
    return null;
  }
}
