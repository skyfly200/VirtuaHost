import { authorize } from "../auth.js";
import { createLogger } from "../log.js";
import { authorizeUrl, fetchProfile, isProvider, makeState, providerConfigured, readState } from "../oauth.js";
import { linkIdentity, unlinkIdentity, usernameForIdentity } from "../profile-store.js";
import { findAccount, issueToken } from "../session.js";
import { getUser, saveUser } from "../user-store.js";

const log = createLogger("oauth");
const back = (origin: string, hash: string) => new Response(null, { status: 302, headers: { location: `${origin}/${hash}`, "cache-control": "no-store" } });

// GET    /api/oauth/:provider/start     begins a sign-in (browser navigation) and redirects to Google/GitHub
// POST   /api/oauth/:provider/start     signed in: { url } to send the browser to, to link that login to the current account
// GET    /api/oauth/:provider/callback  where Google/GitHub sends the browser back; signs in or links, then returns to the page
// DELETE /api/oauth/:provider           signed in: unlink it from the current account
// A Google/GitHub login signs in only an account it was linked to; it never creates one.
export async function handleOauth(req: Request, providerName: string | undefined, action: string | undefined): Promise<Response> {
  if (!isProvider(providerName)) return Response.json({ error: "Unknown provider" }, { status: 404 });
  const provider = providerName;
  const origin = new URL(req.url).origin;

  if (req.method === "DELETE" && !action) {
    const { who, denied } = await authorize(req);
    if (denied) return denied;
    if (who.via !== "login") return Response.json({ error: "Sign in with a username first" }, { status: 400 });
    const removed = await unlinkIdentity(who.username, provider);
    if (removed) log.info("identity unlinked", { username: who.username, provider });
    return removed ? new Response(null, { status: 204 }) : Response.json({ error: `${provider} is not linked` }, { status: 404 });
  }

  if (action === "start") {
    if (!providerConfigured(provider)) return Response.json({ error: `Sign-in with ${provider} is not set up on this site (see lib/oauth.ts for the settings)` }, { status: 503 });
    if (req.method === "GET") return Response.redirect(authorizeUrl(provider, origin, makeState({ mode: "login", provider })), 302);
    if (req.method === "POST") {
      const { who, denied } = await authorize(req);
      if (denied) return denied;
      if (who.via !== "login") return Response.json({ error: "Sign in with a username first" }, { status: 400 });
      return Response.json({ url: authorizeUrl(provider, origin, makeState({ mode: "link", provider, username: who.username })) });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (action === "callback" && req.method === "GET") {
    const url = new URL(req.url);
    const state = readState(url.searchParams.get("state") ?? "");
    const code = url.searchParams.get("code");
    if (!state || state.provider !== provider || !code || !providerConfigured(provider)) return back(origin, "#sso-error=expired");
    let profile;
    try { profile = await fetchProfile(provider, code, origin); } catch (err) { log.warn("provider exchange failed", { provider, err }); return back(origin, "#sso-error=provider"); }

    if (state.mode === "link" && state.username) {
      if (!(await findAccount(state.username))) return back(origin, "#sso-error=account");
      const clash = await linkIdentity(state.username, provider, profile);
      if (clash) { log.warn("identity already linked elsewhere", { provider, username: state.username }); return back(origin, "#sso-error=taken"); }
      log.info("identity linked", { username: state.username, provider });
      return back(origin, `#account-linked=${provider}`);
    }

    const username = await usernameForIdentity(provider, profile.id);
    const account = username ? await findAccount(username) : null;
    if (!account) { log.warn("no linked account for sign-in", { provider }); return back(origin, "#sso-error=unlinked"); }
    if (account.source === "database") {
      const user = await getUser(account.username);
      if (user) await saveUser({ ...user, lastLoginAt: new Date().toISOString() }).catch(() => {});
    }
    log.info("signed in", { username: account.username, role: account.role, via: provider });
    return back(origin, `#sso=${issueToken(account.username).token}`);
  }
  return new Response("Method Not Allowed", { status: 405 });
}
