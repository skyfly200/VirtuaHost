import { authorize } from "../auth.js";
import { stationsNear } from "../coverage.js";
import { getHostStatus } from "../host-store.js";
import { listQueue } from "../queue-store.js";
import { listSchedules } from "../schedule-store.js";
import { sanitizeStation, STATION_ID, type Station } from "../station-profile.js";
import { deleteStation, getStation, listStations, newStationId, saveStation } from "../station-profile-store.js";
import { listClips } from "../store.js";

// Station profiles, kept on the site whether or not any station has a server yet.
//   GET /api/stations              all (the default station when you have made none)
//   POST /api/stations             create
//   GET|PUT|DELETE /api/stations/:id
//   GET /api/stations/:id/summary  what the site holds for it: clips, schedules, queued items, host status
export async function handleStations(req: Request, id: string | undefined, action: string | undefined): Promise<Response> {
  const { denied } = await authorize(req, { admin: req.method !== "GET" });
  if (denied) return denied;
  const json = async () => { try { return await req.json(); } catch { return undefined; } };

  if (!id) {
    if (req.method === "GET") {
      const stations = await listStations();
      // ?near=lat,lon (or ?place=Houston, TX is looked up first by the caller via /api/places): also rank the stations by distance from that point
      // and say whether each one's coverage circle contains it. For choosing which stations an event drop is relevant to (docs/COVERAGE.md).
      const near = new URL(req.url).searchParams.get("near");
      if (near) {
        const [lat, lon] = near.split(",").map(Number);
        if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return Response.json({ error: "near is lat,lon, for example 29.76,-95.37" }, { status: 400 });
        return Response.json({ stations, near: stationsNear(stations, { lat, lon }) });
      }
      return Response.json({ stations });
    }
    if (req.method === "POST") {
      const clean = sanitizeStation(await json());
      if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
      const station: Station = { id: newStationId(clean.station.name), ...clean.station };
      await saveStation(station);
      return Response.json({ station }, { status: 201 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!STATION_ID.test(id)) return Response.json({ error: "Station not found" }, { status: 404 });
  const existing = await getStation(id);
  if (!existing) return Response.json({ error: "Station not found" }, { status: 404 });

  if (action === "summary" && req.method === "GET") {
    const mine = id === "default" ? (s: string | undefined) => !s || s === "default" : (s: string | undefined) => s === id;
    const [clips, schedules, queue, host] = await Promise.all([listClips(), listSchedules(), listQueue(200), getHostStatus(id === "default" ? undefined : id)]);
    const own = schedules.filter((s) => mine(s.stationId));
    return Response.json({
      clips: clips.filter((c) => mine(c.info?.station)).length,
      promos: clips.filter((c) => mine(c.info?.station) && c.info?.kind === "promo").length,
      schedules: own.length,
      schedulesOn: own.filter((s) => s.enabled).length,
      nextRun: own.filter((s) => s.enabled && s.nextAt).map((s) => s.nextAt as string).sort()[0] ?? null,
      queued: queue.filter((q) => q.status === "queued" && mine(q.stationId)).length,
      hostSeenAt: host?.reportedAt ?? null,
    });
  }
  if (action) return new Response("Not Found", { status: 404 });

  if (req.method === "GET") return Response.json({ station: existing });
  if (existing.builtin) return Response.json({ error: "This is the placeholder station named by STATION_NAME. Create your own station to change details." }, { status: 403 });

  if (req.method === "PUT") {
    const clean = sanitizeStation(await json());
    if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
    const station: Station = { id, ...clean.station };
    await saveStation(station);
    return Response.json({ station });
  }
  if (req.method === "DELETE") {
    await deleteStation(id);
    return new Response(null, { status: 204 });
  }
  return new Response("Method Not Allowed", { status: 405 });
}
