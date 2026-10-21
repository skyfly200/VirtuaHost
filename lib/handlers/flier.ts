import { checkAuth } from "../auth.js";
import { activeProvider, complete, NO_PROVIDER_MESSAGE, readImage } from "../ai.js";
import { IMAGE_URL, MAX_IMAGE_CHARS, normalizeEvent, parseJsonObject, parseVariants, PROMO_SYSTEM_PROMPT, promoFacts, READ_SYSTEM_PROMPT } from "../flier.js";
import { resolveTextModel } from "../openrouter.js";
import { getPersona } from "../persona-store.js";
import { getStation } from "../station-profile-store.js";
import { validTimeZone } from "../schedule.js";

const today = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).format(new Date());

// POST /api/flier/read   { image?: data URL, text?: pasted text, tz? }  -> { event }  (details read off the flier, times resolved in tz)
// POST /api/flier/promo  { event, tz?, personaId?, count?, length? }    -> { event, variants }  (spoken spots, nothing voiced yet)
export async function handleFlier(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Request body must be JSON" }, { status: 400 });

  const provider = activeProvider();
  if (!provider) return Response.json({ error: NO_PROVIDER_MESSAGE }, { status: 503 });
  const station = typeof body.station === "string" ? await getStation(body.station) : null;
  const tz = typeof body.tz === "string" && validTimeZone(body.tz) ? body.tz : station?.tz ?? "UTC";
  const personaId = typeof body.personaId === "string" ? body.personaId : "";
  const persona = personaId ? await getPersona(personaId) : null;
  if (personaId && !persona) return Response.json({ error: "Unknown persona" }, { status: 400 });
  // The writing model: the request's, else the persona's, else the station's, else the site's default.
  const textModel = provider === "openrouter" ? (resolveTextModel(typeof body.textModel === "string" ? body.textModel : undefined, [persona?.textModel, station?.defaultTextModel]) as { model?: string; error?: string }) : undefined;
  if (textModel?.error) return Response.json({ error: textModel.error }, { status: 400 });

  if (path === "/api/flier/read") {
    const image = typeof body.image === "string" ? body.image : "";
    const pasted = typeof body.text === "string" ? body.text.trim().slice(0, 4000) : "";
    if (!image && !pasted) return Response.json({ error: "Send a picture of the flier, or paste its text" }, { status: 400 });
    if (image && (image.length > MAX_IMAGE_CHARS || !IMAGE_URL.test(image))) return Response.json({ error: "The picture must be a PNG, JPEG, WebP or GIF under about 3 MB" }, { status: 400 });
    let reply: string;
    try {
      const system = READ_SYSTEM_PROMPT(today(tz), tz);
      reply = image
        ? await readImage({ system, prompt: pasted ? `Read this flier. Extra text from the organiser:\n${pasted}` : "Read this flier.", image, provider })
        : await complete({ system, prompt: `Here is the text of a flier:\n${pasted}`, provider, textModel: textModel?.model });
    } catch (err) {
      return Response.json({ error: `Could not read the flier: ${(err as Error).message}` }, { status: 502 });
    }
    const raw = parseJsonObject(reply);
    if (!raw) return Response.json({ error: "The model did not return event details. Try a clearer picture, or paste the text." }, { status: 502 });
    // A flier that is already over is still shown (to be corrected), just without the "over" check.
    const read = normalizeEvent({ ...raw, name: raw.name || "Untitled event" }, tz, 0);
    return "event" in read ? Response.json({ event: read.event }) : Response.json({ error: read.error }, { status: 502 });
  }

  if (path === "/api/flier/promo") {
    const checked = normalizeEvent(body.event, tz);
    if ("error" in checked) return Response.json({ error: checked.error }, { status: 400 });
    const count = Math.min(4, Math.max(1, Math.floor(Number(body.count)) || 3));
    const length = body.length === "medium" ? "medium" : "short";
    let reply: string;
    try {
      reply = await complete({ system: PROMO_SYSTEM_PROMPT(station?.name || process.env.STATION_NAME || "the station", count, length, persona?.instructions), prompt: promoFacts(checked.event), provider, textModel: textModel?.model });
    } catch (err) {
      return Response.json({ error: `Could not write the promo: ${(err as Error).message}` }, { status: 502 });
    }
    const variants = parseVariants(reply);
    if (!variants.length) return Response.json({ error: "The model did not write a promo. Try again." }, { status: 502 });
    return Response.json({ event: checked.event, variants });
  }

  return new Response("Not Found", { status: 404 });
}
