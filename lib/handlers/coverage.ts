import { authorize } from "../auth.js";
import { modelFor } from "../coverage.js";
import { coverageModel, ANTENNAS, ENVIRONMENTS, LEVELS } from "../propagation.js";
import { getStation } from "../station-profile-store.js";
import { transmitterOf } from "../station-profile.js";

// The quick coverage estimate (power, antenna and height -> a circle or rough ellipse; lib/propagation.ts). Nothing here calls an AI or a
// network service.
//   GET  /api/coverage?station=<id>                    the model for a saved station
//   POST /api/coverage { lat, lon, transmitter }       the model for what is being edited, before saving
// -> { coverage: { erpWatts, reachKm, levels, geojson, assumptions } | null, options: { antennas, environments, levels } }
export async function handleCoverage(req: Request): Promise<Response> {
  const { denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "GET" && req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const options = { antennas: Object.entries(ANTENNAS).map(([id, a]) => ({ id, label: a.label, gainDbd: a.gainDbd, directional: a.directional })), environments: Object.entries(ENVIRONMENTS).map(([id, db]) => ({ id, lossDb: db })), levels: LEVELS };

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("station") || undefined;
    const station = await getStation(id);
    if (!station) return Response.json({ error: "Unknown station" }, { status: 404 });
    return Response.json({ coverage: modelFor(station), options });
  }

  const body = (await req.json().catch(() => null)) as { lat?: unknown; lon?: unknown; transmitter?: unknown } | null;
  if (!body) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  const lat = Number(body.lat); const lon = Number(body.lon);
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return Response.json({ error: "Give the station's latitude and longitude (find its place first)" }, { status: 400 });
  const { transmitter } = transmitterOf(body.transmitter);
  return Response.json({ coverage: transmitter ? coverageModel(transmitter, { lat, lon }) : null, options });
}
