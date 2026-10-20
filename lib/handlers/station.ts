import { checkStationAuth } from "../station-auth.js";
import { claimNext, finish, getItem } from "../queue-store.js";
import { getClip } from "../store.js";
import { isSkipped, sanitizeStatus } from "../host.js";
import { makeHostLink } from "../host-link.js";
import { getHostConfig, saveHostStatus } from "../host-store.js";

// What the station daemon calls (station key, not a login):
//   GET  /api/station/next        claim the oldest waiting item -> { item } or { item: null }
//   GET  /api/station/clips/:id   the audio of a clip
//   POST /api/station/ack         { id, status: "played" | "failed" | "skipped", error? }
//   GET  /api/station/host         the virtual host's settings
//   POST /api/station/host/link    { artist, title } -> writes and voices a link, saved as a clip: { clipId, text, audioUrl, fx, preempt }
//   POST /api/station/host/status  what the daemon's host loop is doing (shown in the site)
export async function handleStation(req: Request): Promise<Response> {
  const denied = checkStationAuth(req);
  if (denied) return denied;

  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (path === "/api/station/next" && req.method === "GET") {
    const item = await claimNext();
    if (!item) return Response.json({ item: null });
    return Response.json({ item: { id: item.id, title: item.title, play: item.play, preempt: item.preempt, ...(item.fx ? { fx: item.fx } : {}), ...(item.info ? { info: item.info } : {}), ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}), audioUrl: `/api/station/clips/${item.clipId}` } });
  }

  const clip = /^\/api\/station\/clips\/([A-Za-z0-9-]{1,64})$/.exec(path);
  if (clip && req.method === "GET") {
    const found = await getClip(clip[1]);
    if (!found) return Response.json({ error: "Clip not found" }, { status: 404 });
    return new Response(found.data, { headers: { "content-type": found.metadata.mimeType, "content-length": String(found.data.byteLength) } });
  }

  if (path === "/api/station/ack" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { id?: unknown; status?: unknown; error?: unknown } | null;
    if (!body || typeof body.id !== "string" || !["played", "failed", "skipped"].includes(String(body.status))) {
      return Response.json({ error: 'Send { id, status: "played" | "failed" | "skipped" }' }, { status: 400 });
    }
    if (!(await getItem(body.id))) return Response.json({ error: "Unknown queue item" }, { status: 404 });
    const done = await finish(body.id, body.status as "played" | "failed" | "skipped", typeof body.error === "string" ? body.error : undefined);
    return Response.json({ item: done });
  }

  if (path === "/api/station/host" && req.method === "GET") return Response.json({ config: await getHostConfig() });

  if (path === "/api/station/host/link" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { artist?: unknown; title?: unknown } | null;
    const title = typeof body?.title === "string" ? body.title.trim().slice(0, 200) : "";
    const artist = typeof body?.artist === "string" ? body.artist.trim().slice(0, 200) : "";
    if (!title) return Response.json({ error: "title is required" }, { status: 400 });
    const config = await getHostConfig();
    if (!config.enabled) return Response.json({ error: "The virtual host is switched off" }, { status: 409 });
    if (isSkipped(artist, title, config)) return Response.json({ error: "That track is on the skip list" }, { status: 409 });
    const made = await makeHostLink(artist, title, config);
    if (!made.ok) return Response.json({ error: made.error }, { status: made.status });
    return Response.json({ clipId: made.id, text: made.scriptText, source: made.source, audioUrl: `/api/station/clips/${made.id}`, fx: config.fx || undefined, preempt: config.preempt, ...(made.note ? { note: made.note } : {}) });
  }

  if (path === "/api/station/host/status" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return Response.json({ error: "Send the status as JSON" }, { status: 400 });
    await saveHostStatus(sanitizeStatus(body));
    return Response.json({ ok: true });
  }

  return new Response("Not Found", { status: 404 });
}
