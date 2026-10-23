import { authorize } from "../auth.js";
import { searchPlaces } from "../places.js";

// GET /api/places?q=Houston, TX -> { places: [{ label, name, admin1, country, countryCode, lat, lon, tz, population }] } (up to five, best first).
// Used by the station editor so a station's location can be found by name instead of typing coordinates.
export async function handlePlaces(req: Request): Promise<Response> {
  const { denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });
  const q = new URL(req.url).searchParams.get("q") ?? "";
  if (q.trim().length < 2) return Response.json({ error: "Type at least two letters of a town or city" }, { status: 400 });
  return Response.json({ places: await searchPlaces(q) });
}
