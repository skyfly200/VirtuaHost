import { authorize } from "../auth.js";
import { applyHostPatch, FX_PRESETS } from "../host.js";
import { composeLink } from "../host-link.js";
import { getHostConfig, getHostStatus, saveHostConfig } from "../host-store.js";
import { getStation } from "../station-profile-store.js";

// For the site's users: the virtual host's settings and what the station daemon last reported. Settings are per station: add
// ?station=<id> (no id means the placeholder station).
//   GET  /api/host           { config, status, fxPresets }
//   PUT  /api/host           change settings (any subset)
//   POST /api/host/preview   { artist, title } -> the link that would be said (text only, nothing is voiced)
export async function handleHost(req: Request): Promise<Response> {
  const { denied } = await authorize(req, { admin: req.method !== "GET" });
  if (denied) return denied;
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const stationId = url.searchParams.get("station") || undefined;
  const station = stationId && stationId !== "default" ? await getStation(stationId) : null;
  if (stationId && stationId !== "default" && !station) return Response.json({ error: "Unknown station" }, { status: 404 });

  if (path === "/api/host" && req.method === "GET") {
    return Response.json({ config: await getHostConfig(station), status: await getHostStatus(station?.id), fxPresets: FX_PRESETS, station: station?.id ?? "default" });
  }
  if (path === "/api/host" && req.method === "PUT") {
    let patch: unknown;
    try { patch = await req.json(); } catch { return Response.json({ error: "Request body must be JSON" }, { status: 400 }); }
    try {
      const config = applyHostPatch(await getHostConfig(station), patch);
      await saveHostConfig(config, station?.id);
      return Response.json({ config });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 400 });
    }
  }
  if (path === "/api/host/preview" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { artist?: unknown; title?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    const artist = typeof body?.artist === "string" ? body.artist.trim().slice(0, 200) : "";
    return Response.json(await composeLink(artist, title, await getHostConfig(station), station));
  }
  return new Response("Method Not Allowed", { status: 405 });
}
