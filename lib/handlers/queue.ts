import { authorize, canView } from "../auth.js";
import { isExpired } from "../clip-info.js";
import { enqueue, finish, getItem, listQueue } from "../queue-store.js";
import { getClip } from "../store.js";

// For the site's users: see what is waiting for the station, send an existing clip to it, or cancel a waiting one.
//   GET /api/queue                 newest first
//   POST /api/queue                { clipId, play?, preempt?, fx? }
//   DELETE /api/queue/:id          cancel an item that has not been collected yet
export async function handleQueue(req: Request, id: string | undefined): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;

  if (!id && req.method === "GET") return Response.json({ items: await listQueue() });

  if (!id && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { clipId?: unknown; play?: unknown; preempt?: unknown; fx?: unknown } | null;
    if (!body || typeof body.clipId !== "string") return Response.json({ error: "clipId is required" }, { status: 400 });
    const clip = await getClip(body.clipId);
    if (!clip || !canView(who, clip.metadata.ownerId)) return Response.json({ error: "Clip not found" }, { status: 404 });
    if (isExpired(clip.metadata.info)) return Response.json({ error: "That clip has expired (its event is over), so it will not be sent" }, { status: 409 });
    const item = await enqueue({
      clipId: body.clipId,
      ...(clip.metadata.info ? { info: clip.metadata.info } : {}),
      title: clip.metadata.scriptText,
      play: body.play === true,
      preempt: body.preempt === true,
      ...(typeof body.fx === "string" || (body.fx && typeof body.fx === "object") ? { fx: body.fx as string } : {}),
    });
    return Response.json({ item }, { status: 201 });
  }

  if (id && req.method === "DELETE") {
    const item = await getItem(id);
    if (!item) return Response.json({ error: "Not found" }, { status: 404 });
    if (item.status !== "queued") return Response.json({ error: "Only an item that has not been collected yet can be cancelled" }, { status: 409 });
    await finish(id, "skipped", "cancelled");
    return new Response(null, { status: 204 });
  }

  return new Response("Method Not Allowed", { status: 405 });
}
