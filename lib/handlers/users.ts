import { authorize } from "../auth.js";
import { createLogger } from "../log.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { aiUsage, effectiveQuota, sanitizeQuota } from "../quota.js";
import { findAccount, parseUsers } from "../session.js";
import { deleteUser, getUser, listUsers, MIN_PASSWORD_LENGTH, normalizeUsername, publicUser, saveUser, USERNAME, type Role, type User } from "../user-store.js";

const log = createLogger("users");
const json = async (req: Request): Promise<Record<string, unknown> | undefined> => {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const badPassword = (p: unknown): string | null =>
  typeof p !== "string" || p.length < MIN_PASSWORD_LENGTH || p.length > 200 ? `The password must be ${MIN_PASSWORD_LENGTH}-200 characters (a few random words is fine)` : null;
const roleOf = (v: unknown): Role | null => (v === "admin" || v === "user" ? v : null);

// Admin: GET /api/users (list), POST /api/users { username, password, role?, quota? }, PATCH /api/users/:name { password?, role?, disabled?, quota? },
//        DELETE /api/users/:name.
// Anyone signed in: GET /api/users/me (who am I, my limits and usage), PATCH /api/users/me { currentPassword, newPassword }.
// People in LOGIN_USERS are bootstrap admins: listed, but not editable here.
export async function handleUsers(req: Request, name: string | undefined): Promise<Response> {
  if (name === "me") return handleMe(req);

  const { who, denied } = await authorize(req, { admin: true });
  if (denied) return denied;

  if (!name) {
    if (req.method === "GET") {
      const envAdmins = [...parseUsers().keys()].map((username) => ({ username, role: "admin", disabled: false, quota: {}, createdAt: null, lastLoginAt: null, source: "env" }));
      const users = (await listUsers()).map(publicUser);
      return Response.json({ users: [...envAdmins, ...users], defaults: effectiveQuota(undefined) });
    }
    if (req.method === "POST") {
      const body = await json(req);
      if (!body) return Response.json({ error: "Send the user as JSON" }, { status: 400 });
      const username = typeof body.username === "string" ? body.username.trim() : "";
      if (!USERNAME.test(username)) return Response.json({ error: "Usernames use letters, numbers and . _ @ - only (up to 40)" }, { status: 400 });
      const pw = badPassword(body.password);
      if (pw) return Response.json({ error: pw }, { status: 400 });
      const role = body.role === undefined ? "user" : roleOf(body.role);
      if (!role) return Response.json({ error: 'role must be "admin" or "user"' }, { status: 400 });
      const quota = sanitizeQuota(body.quota);
      if ("error" in quota) return Response.json({ error: quota.error }, { status: 400 });
      if (parseUsers().has(username) || (await getUser(username))) return Response.json({ error: "That username is taken" }, { status: 409 });
      const now = new Date().toISOString();
      const user: User = { username: normalizeUsername(username), passwordHash: hashPassword(body.password as string), role, quota, createdAt: now, updatedAt: now };
      await saveUser(user);
      log.info("user created", { username: user.username, role, by: who.username });
      return Response.json({ user: publicUser(user) }, { status: 201 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (parseUsers().has(name)) return Response.json({ error: "That account comes from LOGIN_USERS; change it in the site's environment settings" }, { status: 409 });
  const user = await getUser(name);
  if (!user) return Response.json({ error: "User not found" }, { status: 404 });
  const self = normalizeUsername(name) === who.username;

  if (req.method === "PATCH") {
    const body = await json(req);
    if (!body) return Response.json({ error: "Send the changes as JSON" }, { status: 400 });
    const next: User = { ...user };
    if (body.password !== undefined) {
      const pw = badPassword(body.password);
      if (pw) return Response.json({ error: pw }, { status: 400 });
      next.passwordHash = hashPassword(body.password as string);
    }
    if (body.role !== undefined) {
      const role = roleOf(body.role);
      if (!role) return Response.json({ error: 'role must be "admin" or "user"' }, { status: 400 });
      if (self && role !== "admin") return Response.json({ error: "You cannot remove your own admin role" }, { status: 400 });
      next.role = role;
    }
    if (body.disabled !== undefined) {
      if (typeof body.disabled !== "boolean") return Response.json({ error: "disabled must be true or false" }, { status: 400 });
      if (self && body.disabled) return Response.json({ error: "You cannot disable yourself" }, { status: 400 });
      next.disabled = body.disabled;
    }
    if (body.quota !== undefined) {
      const quota = sanitizeQuota(body.quota);
      if ("error" in quota) return Response.json({ error: quota.error }, { status: 400 });
      next.quota = quota;
    }
    await saveUser(next);
    log.info("user updated", { username: next.username, changed: Object.keys(body).filter((k) => k !== "password"), passwordChanged: body.password !== undefined, by: who.username });
    return Response.json({ user: publicUser(next) });
  }
  if (req.method === "DELETE") {
    if (self) return Response.json({ error: "You cannot delete yourself" }, { status: 400 });
    await deleteUser(name);
    log.info("user deleted", { username: user.username, by: who.username });
    return new Response(null, { status: 204 });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

async function handleMe(req: Request): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;

  if (req.method === "GET") {
    const user = who.via === "login" ? await getUser(who.username) : null;
    const limits = who.role === "admin" ? {} : effectiveQuota(user?.quota);
    return Response.json({ username: who.username, role: who.role, quota: limits, usage: who.role === "admin" ? null : await aiUsage(who.username).catch(() => null) });
  }
  if (req.method === "PATCH") {
    if (who.via !== "login") return Response.json({ error: "Sign in with a username to change a password" }, { status: 400 });
    const body = await json(req);
    const pw = badPassword(body?.newPassword);
    if (pw) return Response.json({ error: pw }, { status: 400 });
    const account = await findAccount(who.username);
    if (!account || account.source !== "database") return Response.json({ error: "This account comes from LOGIN_USERS; change it in the site's environment settings" }, { status: 409 });
    if (typeof body?.currentPassword !== "string" || !verifyPassword(body.currentPassword, account.passwordHash)) return Response.json({ error: "Your current password is wrong" }, { status: 403 });
    const user = await getUser(who.username);
    if (!user) return Response.json({ error: "User not found" }, { status: 404 });
    await saveUser({ ...user, passwordHash: hashPassword(body.newPassword as string) });
    log.info("password changed", { username: who.username });
    return Response.json({ ok: true });
  }
  return new Response("Method Not Allowed", { status: 405 });
}
