import { authorize, canView } from "../auth.js";
import { contextFor, renderTemplate, variableValues } from "../drop-template.js";
import { getPersona } from "../persona-store.js";
import { getStation } from "../station-profile-store.js";

// The placeholders that can be used in drops, and a way to try a text with today's values. Nothing here calls an AI service.
//   GET  /api/template?station=&persona=&seconds=      { variables: [{ name, group, description, example, value }], syntax }
//   POST /api/template { text, station?, persona?, seconds?, artist?, title? }   { text, used, missing }
const SYNTAX = [
  { syntax: "{{name}}", meaning: "the value of a variable, for example {{time}}" },
  { syntax: "{{name|fallback}}", meaning: "the fallback when there is no value, for example {{weather|a lovely day}}" },
  { syntax: "{{pick: a | b | c}}", meaning: "one of the choices, chosen at random each time" },
];

export async function handleTemplate(req: Request): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "GET" && req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const url = new URL(req.url);
  const body = req.method === "POST" ? ((await req.json().catch(() => null)) as Record<string, unknown> | null) : null;
  if (req.method === "POST" && !body) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  const pick = (key: string): string | undefined => { const v = body ? body[key] : url.searchParams.get(key); return typeof v === "string" && v ? v : undefined; };

  const station = await getStation(pick("station"));
  if (pick("station") && !station) return Response.json({ error: "Unknown station" }, { status: 404 });
  const persona = pick("persona") ? await getPersona(pick("persona")!) : null;
  const seen = persona && canView(who, persona.ownerId) ? persona : null;
  const secondsRaw = Number(body ? body.seconds : url.searchParams.get("seconds"));
  const ctx = contextFor({
    station, persona: seen, targetSeconds: Number.isFinite(secondsRaw) && secondsRaw >= 3 && secondsRaw <= 90 ? secondsRaw : undefined,
    song: pick("artist") || pick("title") ? { artist: pick("artist"), title: pick("title") } : undefined,
  });

  if (req.method === "GET") return Response.json({ variables: await variableValues(ctx), syntax: SYNTAX });
  const text = typeof body!.text === "string" ? body!.text.slice(0, 4000) : "";
  if (!text) return Response.json({ error: "text is required" }, { status: 400 });
  return Response.json(await renderTemplate(text, ctx));
}
