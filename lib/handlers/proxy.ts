import { authorize } from "../auth.js";
import { createLogger } from "../log.js";

const log = createLogger("proxy");

// The web UI talks to the radio side of the system through this site, so the browser only ever signs in here:
//
//   /api/hub/*    -> HUB_URL/*     with HUB_KEY      (the hub that controls the stations: Control Panel)
//   /api/voice/*  -> VOICE_URL/*   with VOICE_KEY    (a Chips Voice server: Voice Lab)
//
// Both are off until their URL and key are set. The keys never reach the browser, and anyone who is signed in here can use
// everything the key allows, so treat a login like an admin account. Netlify functions accept request bodies up to about 6 MB,
// so uploads through here are capped at 5 MB.
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

interface Target {
  name: string;
  url: string;
  key: string;
  env: string;
}

function targetFor(kind: string): Target | null {
  if (kind === "hub") return { name: "hub", url: process.env.HUB_URL ?? "", key: process.env.HUB_KEY ?? "", env: "HUB_URL and HUB_KEY" };
  if (kind === "voice") return { name: "voice server", url: process.env.VOICE_URL ?? "", key: process.env.VOICE_KEY ?? "", env: "VOICE_URL and VOICE_KEY" };
  return null;
}

// What the UI should offer: each part is "on" only when its address and key are both set.
export const features = () => ({
  hub: Boolean(process.env.HUB_URL && process.env.HUB_KEY),
  voice: Boolean(process.env.VOICE_URL && process.env.VOICE_KEY),
});

export async function handleProxy(req: Request): Promise<Response> {
  const { denied } = await authorize(req, { admin: true });
  if (denied) return denied;

  const incoming = new URL(req.url);
  const match = incoming.pathname.match(/^\/api\/(hub|voice)(\/.*)?$/);
  const target = match ? targetFor(match[1]) : null;
  if (!match || !target) return Response.json({ error: "Not found" }, { status: 404 });

  if (!target.url || !target.key) {
    return Response.json({ error: `The ${target.name} is not connected yet: set ${target.env} on the site`, notConnected: true }, { status: 503 });
  }

  let base: URL;
  try {
    base = new URL(target.url.replace(/\/+$/, "") + "/");
  } catch {
    return Response.json({ error: `The ${target.name} address is not a valid URL` }, { status: 503 });
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (base.protocol !== "https:" && !(local && base.protocol === "http:")) {
    return Response.json({ error: `The ${target.name} address must use https (the key travels in a header)` }, { status: 503 });
  }

  // Only the part after /api/hub or /api/voice is forwarded, and it must stay on the configured server.
  const rest = (match[2] ?? "/").replace(/^\/+/, "");
  const upstreamUrl = new URL(rest, base);
  if (upstreamUrl.origin !== base.origin || !upstreamUrl.pathname.startsWith(base.pathname)) {
    return Response.json({ error: "Bad path" }, { status: 400 });
  }
  upstreamUrl.search = incoming.search;

  let body: ArrayBuffer | undefined;
  if (req.method !== "GET" && req.method !== "HEAD") {
    const declared = Number(req.headers.get("content-length") ?? 0);
    if (declared > MAX_BODY_BYTES) return Response.json({ error: "Upload is too large for this site (5 MB limit)" }, { status: 413 });
    body = await req.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) return Response.json({ error: "Upload is too large for this site (5 MB limit)" }, { status: 413 });
  }

  // Only what the radio side needs is passed on; the caller's own credentials are replaced with the server-side key.
  const headers: Record<string, string> = { "x-api-key": target.key };
  const contentType = req.headers.get("content-type");
  if (contentType) headers["content-type"] = contentType;
  const accept = req.headers.get("accept");
  if (accept) headers.accept = accept;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, { method: req.method, headers, body, signal: AbortSignal.timeout(25_000), redirect: "manual" });
  } catch (err) {
    const timedOut = (err as Error).name === "TimeoutError";
    log.error("proxy request failed", { target: target.name, timedOut, err });
    return Response.json({ error: `The ${target.name} did not answer${timedOut ? " in time" : ""}: ${(err as Error).message}` }, { status: 502 });
  }

  const out = new Headers();
  for (const name of ["content-type", "cache-control"]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  // A key the server rejected is a configuration problem here, not something to blame on the signed-in person.
  if (upstream.status === 401 || upstream.status === 403) {
    return Response.json({ error: `The ${target.name} rejected this site's key: check ${target.env}` }, { status: 502 });
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
