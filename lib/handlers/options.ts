import { checkAuth } from "../auth.js";
import { activeProvider, NO_PROVIDER_MESSAGE } from "../ai.js";
import { textModels, allSpeechModels, defaultTextModel, defaultSpeechModel, allowAnyModel } from "../openrouter.js";
import { cuesFor, GEMINI_DIRECT_CUES } from "../cues.js";
import { features } from "./proxy.js";
import { queueMode } from "../station-send.js";
import { libraryFeatures } from "../library/index.js";
import { getStation } from "../station-profile-store.js";
import { TONES, FORMATS, MAX_TONE_LENGTH, fillStation } from "../formats.js";

// What the test console offers: the provider in use, the models that can be chosen, tones, and script formats with examples.
export async function handleOptions(req: Request): Promise<Response> {
  const denied = await checkAuth(req);
  if (denied) return denied;
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const provider = activeProvider();
  // ?station=<id>: the examples and the name shown are for that station
  const chosen = await getStation(new URL(req.url).searchParams.get("station") || undefined);
  const station = chosen?.name || process.env.STATION_NAME || "the station";
  const openrouter = provider === "openrouter";

  const speech = openrouter ? (await allSpeechModels()).map((m) => ({ ...m, cues: cuesFor(m.id) })) : [];
  // The default must be a model that is offered: a configured default that OpenRouter does not list would only fail.
  const wanted = defaultSpeechModel().id;
  const defaultSpeech = speech.some((m) => m.id === wanted) ? wanted : speech[0]?.id ?? wanted;

  return Response.json({
    provider,
    features: { ...features(), library: libraryFeatures(), stationQueue: queueMode() },
    ...(provider ? {} : { warning: NO_PROVIDER_MESSAGE }),
    station,
    // Models can only be chosen with OpenRouter; with Gemini direct the models are fixed.
    models: openrouter
      ? { choosable: true, allowAny: allowAnyModel(), text: textModels(), speech, defaultText: defaultTextModel(), defaultSpeech }
      : { choosable: false, fixedCues: GEMINI_DIRECT_CUES, allowAny: false, text: [], speech: [], defaultText: "", defaultSpeech: "" },
    tones: TONES,
    maxToneLength: MAX_TONE_LENGTH,
    formats: FORMATS.map((f) => ({ ...f, example: fillStation(f.example, station) })),
  });
}
