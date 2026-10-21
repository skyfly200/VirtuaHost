import { authorize } from "../auth.js";
import { createLogger } from "../log.js";
import { clearProviderKey, describeKeys, keyStorageConfigured, PROVIDERS, setProviderKey, validKey, type Owner } from "../provider-keys.js";
import { STATION_ID } from "../station-profile.js";
import { getStation } from "../station-profile-store.js";
import type { KeyProvider } from "../credentials.js";

const log = createLogger("keys");

// AI provider keys. A key is write-only: it can be set and removed, never read back (only whether it is set and its last four characters).
//   GET    /api/keys[?station=<id>]            { user: { openrouter?, gemini? }, station?: { ... } }   (the station part is for admins)
//   PUT    /api/keys   { provider, key, station? }   saves the caller's own key, or the station's when `station` is given (admin)
//   DELETE /api/keys?provider=<p>[&station=<id>]     removes it
// The person's key is used for their own requests (and is not counted against their AI quota); the station's for requests made for
// that station; the site's (environment) for everything else.
export async function handleKeys(req: Request): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;
  if (who.via !== "login") return Response.json({ error: "Sign in with a username to manage keys" }, { status: 400 });
  const url = new URL(req.url);
  const json = req.method === "PUT" ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null;
  const stationId = (url.searchParams.get("station") ?? (typeof json?.station === "string" ? json.station : "")) || undefined;

  let owner: Owner = { kind: "user", id: who.username };
  if (stationId && req.method !== "GET") {
    if (who.role !== "admin") return Response.json({ error: "Only an admin can change a station's key" }, { status: 403 });
    if (!STATION_ID.test(stationId) || !(await getStation(stationId))) return Response.json({ error: "Unknown station" }, { status: 404 });
    owner = { kind: "station", id: stationId };
  }

  if (req.method === "GET") {
    const station = stationId && who.role === "admin" && STATION_ID.test(stationId) && (await getStation(stationId)) ? await describeKeys({ kind: "station", id: stationId }) : undefined;
    return Response.json({ storage: keyStorageConfigured(), user: await describeKeys({ kind: "user", id: who.username }), ...(station ? { station } : {}) });
  }

  if (!keyStorageConfigured()) return Response.json({ error: "Storing keys needs SECRETS_KEY (32+ characters) or SESSION_SECRET set on the site" }, { status: 503 });

  if (req.method === "PUT") {
    const provider = json?.provider as KeyProvider;
    if (!PROVIDERS.includes(provider)) return Response.json({ error: 'provider must be "openrouter" or "gemini"' }, { status: 400 });
    if (!validKey(json?.key)) return Response.json({ error: "That does not look like an API key (16-300 characters, no spaces)" }, { status: 400 });
    await setProviderKey(owner, provider, json!.key as string);
    log.info("provider key set", { owner: `${owner.kind}:${owner.id}`, provider, by: who.username });
    return Response.json({ ok: true });
  }
  if (req.method === "DELETE") {
    const provider = url.searchParams.get("provider") as KeyProvider;
    if (!PROVIDERS.includes(provider)) return Response.json({ error: 'provider must be "openrouter" or "gemini"' }, { status: 400 });
    await clearProviderKey(owner, provider);
    log.info("provider key removed", { owner: `${owner.kind}:${owner.id}`, provider, by: who.username });
    return new Response(null, { status: 204 });
  }
  return new Response("Method Not Allowed", { status: 405 });
}
