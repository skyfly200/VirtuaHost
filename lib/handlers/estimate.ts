import { authorize, canView, type Principal } from "../auth.js";
import { activeProvider } from "../ai.js";
import { buildSystemPrompt, cleanTone, findFormat } from "../formats.js";
import { defaultSpeechModel, ensureListed, resolveTextModel, visionModel } from "../openrouter.js";
import { getPersona } from "../persona-store.js";
import { estimateSpeech, estimateText, type Estimate } from "../pricing.js";
import { contentFilter } from "../content.js";
import { contextFor, promptHelp } from "../drop-template.js";
import { modelPrices } from "../openrouter.js";
import { getStation } from "../station-profile-store.js";
import { stationOf, withKeys } from "../with-keys.js";

const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");

// POST /api/estimate { kind, ... } -> { estimate }. What a request would use, before it is made (nothing is sent to an AI service):
//   write        { prompt, tone?, format?, persona?, textModel?, station? }
//   speak        { text, speechModel?, persona?, station? }
//   flier-read   { image?, text?, station? }
//   flier-promo  { event, count?, persona?, textModel?, station? }
export async function handleEstimate(req: Request): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  return withKeys(who, await stationOf(req), () => estimate(req, who));
}

// With strong language requested, a model that filters is flagged: it may refuse or soften what you wrote.
async function withContent(e: Estimate, explicit: boolean): Promise<Estimate> {
  const info = contentFilter(e.model, (await modelPrices().catch(() => new Map())).get(e.model));
  const flagged = explicit && info.level === "filtered";
  return { ...e, content: info, warn: e.warn || flagged, message: flagged ? `${e.message} Strong language: this model filters content and may refuse or soften it. Choose one marked unfiltered or light.` : e.message };
}

async function estimate(req: Request, who: Principal): Promise<Response> {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  const station = typeof body.station === "string" ? await getStation(body.station) : null;
  const persona = typeof body.persona === "string" ? await getPersona(body.persona) : null;
  const seen = persona && canView(who, persona.ownerId) ? persona : null;
  const provider = activeProvider();

  if (provider === "openrouter") await ensureListed(typeof body.textModel === "string" ? body.textModel : undefined);
  const textModel = (): { model: string } | { error: string } => {
    if (provider !== "openrouter") return { model: "gemini-3.6-flash" };
    return resolveTextModel(typeof body.textModel === "string" ? body.textModel : undefined, [seen?.textModel, station?.defaultTextModel]);
  };

  switch (body.kind) {
    case "write": {
      const m = textModel();
      if ("error" in m) return Response.json({ error: m.error }, { status: 400 });
      const system = buildSystemPrompt({ station: station?.name || process.env.STATION_NAME || "the station", tagline: station?.tagline, tone: cleanTone(body.tone), format: findFormat(str(body.format, 40)), persona: seen?.instructions, explicit: body.explicit === true, targetSeconds: typeof body.seconds === "number" ? body.seconds : undefined, placeholders: promptHelp(contextFor({ station, persona: seen, targetSeconds: typeof body.seconds === "number" ? body.seconds : undefined })) });
      return Response.json({ estimate: await withContent(await estimateText({ kind: "write", model: m.model, inputChars: str(body.prompt, 4000).length, systemChars: system.length, maxOut: 300, expectedOut: 80 }), body.explicit === true) });
    }
    case "speak": {
      const text = str(body.text, 4000).replace(/\[[^\]]*\]/g, "");
      const wanted = typeof body.speechModel === "string" && body.speechModel ? body.speechModel : seen?.speechModel || station?.defaultSpeechModel;
      return Response.json({ estimate: await withContent(await estimateSpeech({ model: provider === "openrouter" ? wanted || defaultSpeechModel().id : "gemini-3.1-flash-tts-preview", chars: text.length }), body.explicit === true) });
    }
    case "flier-read": {
      const image = typeof body.image === "string" && body.image.length > 0;
      const model = provider === "openrouter" ? visionModel() : "gemini-3.6-flash";
      return Response.json({ estimate: await estimateText({ kind: "flier-read", model, inputChars: str(body.text, 4000).length + 120, maxOut: 900, expectedOut: 400, image }) });
    }
    case "flier-promo": {
      const m = textModel();
      if ("error" in m) return Response.json({ error: m.error }, { status: 400 });
      const count = Math.min(4, Math.max(1, Math.floor(Number(body.count)) || 3));
      return Response.json({ estimate: await estimateText({ kind: "flier-promo", model: m.model, inputChars: JSON.stringify(body.event ?? {}).slice(0, 4000).length + (seen?.instructions.length ?? 0), maxOut: 1200, expectedOut: 150 * count }) });
    }
    default:
      return Response.json({ error: 'kind must be "write", "speak", "flier-read" or "flier-promo"' }, { status: 400 });
  }
}
