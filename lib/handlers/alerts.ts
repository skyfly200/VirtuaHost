import { authorize } from "../auth.js";
import { activeAlerts, SEVERITIES, type Severity } from "../alerts.js";
import { getStation } from "../station-profile-store.js";

// GET /api/alerts?station=<id>[&min=Moderate]: the US National Weather Service alerts active at the station's location
// (needs a location on the station profile, or a city). Read-only; airing alerts is the hub's job (docs/ALERTS.md).
export async function handleAlerts(req: Request): Promise<Response> {
  const { denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const url = new URL(req.url);
  const id = url.searchParams.get("station") || undefined;
  const station = await getStation(id);
  if (id && !station) return Response.json({ error: "Unknown station" }, { status: 404 });
  if (!station || (typeof station.lat !== "number" && !station.city)) return Response.json({ error: "Give the station a location (latitude and longitude, or a city) in the Stations tab first" }, { status: 400 });
  const min = url.searchParams.get("min");
  if (min && !(SEVERITIES as readonly string[]).includes(min)) return Response.json({ error: `min is one of ${SEVERITIES.join(", ")}` }, { status: 400 });
  return Response.json({ station: station.id, alerts: await activeAlerts(station, (min as Severity | null) ?? undefined) });
}
