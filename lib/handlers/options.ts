import { checkAuth } from "../auth.js";
import { activeProvider, NO_PROVIDER_MESSAGE } from "../ai.js";
import { textModels, allSpeechModels, defaultTextModel, defaultSpeechModel, allowAnyModel } from "../openrouter.js";
import { cuesFor, GEMINI_DIRECT_CUES } from "../cues.js";
import { features } from "./proxy.js";
import { TONES, FORMATS, MAX_TONE_LENGTH, fillStation } from "../formats.js";

// What the test console offers: the provider in use, the models that can be chosen, tones, and script formats with examples.
export async function handleOptions(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const provider = activeProvider();
  const station = process.env.STATION_NAME || "the station";
  const openrouter = provider === "openrouter";

  return Response.json({
    provider,
    features: features(),
    ...(provider ? {} : { warning: NO_PROVIDER_MESSAGE }),
    station,
    // Models can only be chosen with OpenRouter; with Gemini direct the models are fixed.
    models: openrouter
      ? { choosable: true, allowAny: allowAnyModel(), text: textModels(), speech: (await allSpeechModels()).map((m) => ({ ...m, cues: cuesFor(m.id) })), defaultText: defaultTextModel(), defaultSpeech: defaultSpeechModel().id }
      : { choosable: false, fixedCues: GEMINI_DIRECT_CUES, allowAny: false, text: [], speech: [], defaultText: "", defaultSpeech: "" },
    tones: TONES,
    maxToneLength: MAX_TONE_LENGTH,
    formats: FORMATS.map((f) => ({ ...f, example: fillStation(f.example, station) })),
  });
}
