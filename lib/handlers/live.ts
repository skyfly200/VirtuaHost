import { authorize } from "../auth.js";
import { liveFor } from "../live-inputs.js";
import { getStation } from "../station-profile-store.js";

// GET /api/live?station=<id>: what the writer and the conditional schedules see right now (weather, active alerts, per-road ice/snow
// risk estimated from the weather). Lets the UI show "what would fire" before anything is switched live.
export async function handleLive(req: Request): Promise<Response> {
  const { denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const id = new URL(req.url).searchParams.get("station") || undefined;
  const station = await getStation(id);
  if (id && !station) return Response.json({ error: "Unknown station" }, { status: 404 });
  if (!station || (typeof station.lat !== "number" && !station.city)) return Response.json({ error: "Give the station a location in the Stations tab first" }, { status: 400 });
  const live = await liveFor(station);
  return Response.json({ station: station.id, tempUnit: station.tempUnit ?? "F", ...live });
}
