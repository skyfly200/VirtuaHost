import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IdentityProvider } from "./profile-store.js";

// Sign in with Google or GitHub. These only ever sign in an account that was linked first (Account settings > Sign-in methods);
// they never create accounts. Set, per provider you want, in the site environment:
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   (Google Cloud console > OAuth client, "Web application")
//   GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET   (GitHub > Settings > Developer settings > OAuth Apps)
// Redirect URI for both: https://<your site>/api/oauth/<google|github>/callback  (override the site address with SITE_URL).
// Not verified against the live services.

interface Spec { authUrl: string; tokenUrl: string; scope: string; idEnv: string; secretEnv: string }
const SPECS: Record<IdentityProvider, Spec> = {
  google: { authUrl: "https://accounts.google.com/o/oauth2/v2/auth", tokenUrl: "https://oauth2.googleapis.com/token", scope: "openid email profile", idEnv: "GOOGLE_CLIENT_ID", secretEnv: "GOOGLE_CLIENT_SECRET" },
  github: { authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token", scope: "read:user user:email", idEnv: "GITHUB_CLIENT_ID", secretEnv: "GITHUB_CLIENT_SECRET" },
};

export const providerConfigured = (p: IdentityProvider, env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env[SPECS[p].idEnv] && env[SPECS[p].secretEnv]) && (env.SESSION_SECRET ?? "").length >= 32;
export const configuredProviders = (): IdentityProvider[] => (Object.keys(SPECS) as IdentityProvider[]).filter((p) => providerConfigured(p));
export const isProvider = (v: unknown): v is IdentityProvider => v === "google" || v === "github";

export const redirectUri = (p: IdentityProvider, origin: string): string => `${(process.env.SITE_URL || origin).replace(/\/$/, "")}/api/oauth/${p}/callback`;

// The state travels through the provider and back: signed, short-lived, and says whether this is a sign-in or a link for a named person.
export interface State { mode: "login" | "link"; username?: string; provider: IdentityProvider; nonce: string; exp: number }
const sign = (data: string) => createHmac("sha256", process.env.SESSION_SECRET ?? "").update(`oauth.${data}`).digest();
export function makeState(s: Omit<State, "nonce" | "exp">, now = Date.now()): string {
  const body = Buffer.from(JSON.stringify({ ...s, nonce: randomBytes(8).toString("hex"), exp: now + 10 * 60_000 })).toString("base64url");
  return `${body}.${sign(body).toString("base64url")}`;
}
export function readState(raw: string, now = Date.now()): State | null {
  const [body, mac] = raw.split(".");
  if (!body || !mac) return null;
  const given = Buffer.from(mac, "base64url"), want = sign(body);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
  try {
    const s = JSON.parse(Buffer.from(body, "base64url").toString()) as State;
    return s.exp > now && isProvider(s.provider) && (s.mode === "login" || s.mode === "link") ? s : null;
  } catch { return null; }
}

export function authorizeUrl(p: IdentityProvider, origin: string, state: string): string {
  const spec = SPECS[p];
  const q = new URLSearchParams({ client_id: process.env[spec.idEnv] ?? "", redirect_uri: redirectUri(p, origin), response_type: "code", scope: spec.scope, state });
  if (p === "google") q.set("prompt", "select_account");
  return `${spec.authUrl}?${q}`;
}

export interface Profile_ { id: string; label: string; email?: string }

/** Trades the code for the person's id (and email, label). Throws a short message on failure. */
export async function fetchProfile(p: IdentityProvider, code: string, origin: string, fetcher: typeof fetch = fetch): Promise<Profile_> {
  const spec = SPECS[p];
  const tokenRes = await fetcher(spec.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ code, client_id: process.env[spec.idEnv] ?? "", client_secret: process.env[spec.secretEnv] ?? "", redirect_uri: redirectUri(p, origin), grant_type: "authorization_code" }),
  });
  const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string };
  if (!tokenRes.ok || !tok.access_token) throw new Error(`${p} did not accept the sign-in`);
  const auth = { authorization: `Bearer ${tok.access_token}`, accept: "application/json", "user-agent": "VirtuaHost" };
  if (p === "google") {
    const u = (await (await fetcher("https://openidconnect.googleapis.com/v1/userinfo", { headers: auth })).json().catch(() => ({}))) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
    if (!u.sub) throw new Error("Google did not return an account");
    return { id: u.sub, label: u.email ?? u.name ?? u.sub, ...(u.email && u.email_verified ? { email: u.email } : {}) };
  }
  const u = (await (await fetcher("https://api.github.com/user", { headers: auth })).json().catch(() => ({}))) as { id?: number; login?: string };
  if (!u.id) throw new Error("GitHub did not return an account");
  const mails = (await (await fetcher("https://api.github.com/user/emails", { headers: auth })).json().catch(() => [])) as { email: string; primary: boolean; verified: boolean }[];
  const primary = Array.isArray(mails) ? mails.find((m) => m.primary && m.verified) : undefined;
  return { id: String(u.id), label: u.login ?? String(u.id), ...(primary ? { email: primary.email } : {}) };
}
