import { getStore } from "@netlify/blobs";
import { createLogger } from "../log.js";
import { hubDb } from "../hub/db.js";
import { PullError, ackQueueItem, authenticateStation, getAudio, getQueue, recordHeartbeat } from "../hub/pull.js";

const log = createLogger("hub-pull");

// The hub's station-facing calls, served by the site: /api/pull/stations/:id/{heartbeat, queue, queue/:item/audio, queue/:item/ack}.
// A pull station points its hub address at https://<site>/api/pull and sends its own pull key (x-api-key or Bearer), the key the
// hub shows once when the station is created. It opens only that station's own calls. Needs DATABASE_URL (the hub's Neon database).
const MAX_BODY = 64 * 1024;

const readAudio = async (hash: string): Promise<ArrayBuffer | null> => {
  const store = getStore({ name: "hub-audio", consistency: "strong" });
  return (await store.get(hash, { type: "arrayBuffer" })) ?? null;
};

async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new PullError("body too large", 413);
  try {
    const v = raw ? JSON.parse(raw) : {};
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as Record<string, unknown>;
  } catch {
    throw new PullError("the body must be a JSON object", 400);
  }
}

export async function handleHubPull(req: Request, read: (hash: string) => Promise<ArrayBuffer | null> = readAudio, now: number = Date.now()): Promise<Response> {
  const db = hubDb();
  if (!db) return Response.json({ error: "DATABASE_URL is not set: the hub's database is not connected to this site" }, { status: 503 });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const m = path.match(/^\/api\/pull\/stations\/([^/]+)\/(heartbeat|queue)(?:\/([^/]+)\/(audio|ack))?$/);
  if (!m) return Response.json({ error: "Not found" }, { status: 404 });
  const [, rawId, what, rawItem, sub] = m;
  const stationId = decodeURIComponent(rawId);
  const itemId = rawItem ? decodeURIComponent(rawItem) : "";

  const wantsPost = what === "heartbeat" || sub === "ack";
  if (req.method !== (wantsPost ? "POST" : "GET")) return Response.json({ error: "Method not allowed" }, { status: 405 });

  try {
    const given = req.headers.get("x-api-key") ?? req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
    const station = await authenticateStation(db, stationId, given);
    if (what === "heartbeat") return Response.json(await recordHeartbeat(db, station, (await readJson(req)).status, now));
    if (sub === "audio") {
      const a = await getAudio(db, station, itemId, read);
      return new Response(a.bytes, { headers: { "content-type": a.mime, "content-length": String(a.bytes.byteLength), "x-sha256": a.sha256 } });
    }
    if (sub === "ack") return Response.json(await ackQueueItem(db, station, itemId, await readJson(req), now));
    return Response.json(await getQueue(db, station, now));
  } catch (err) {
    if (err instanceof PullError) return Response.json({ error: err.message }, { status: err.status });
    log.error("pull call failed", { err, stationId, what });
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}
