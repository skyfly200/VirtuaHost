import { checkStationAuth } from "../station-auth.js";
import { claimNext, finish, getItem } from "../queue-store.js";
import { getClip } from "../store.js";

// What the station daemon calls (station key, not a login):
//   GET  /api/station/next        claim the oldest waiting item -> { item } or { item: null }
//   GET  /api/station/clips/:id   the audio of a clip
//   POST /api/station/ack         { id, status: "played" | "failed" | "skipped", error? }
export async function handleStation(req: Request): Promise<Response> {
  const denied = checkStationAuth(req);
  if (denied) return denied;

  const path = new URL(req.url).pathname.replace(/\/+$/, "");

  if (path === "/api/station/next" && req.method === "GET") {
    const item = await claimNext();
    if (!item) return Response.json({ item: null });
    return Response.json({ item: { id: item.id, title: item.title, play: item.play, preempt: item.preempt, ...(item.fx ? { fx: item.fx } : {}), audioUrl: `/api/station/clips/${item.clipId}` } });
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

  return new Response("Not Found", { status: 404 });
}
