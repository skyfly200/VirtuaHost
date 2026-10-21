import { randomUUID } from "node:crypto";
import { activeProvider, writeScript, speak, NO_PROVIDER_MESSAGE } from "../ai.js";
import { ensureListed, resolveTextModel, pickSpeechModel, speechModels, defaultSpeechModel, discoverSpeechModels, type SpeechModel } from "../openrouter.js";
import { cuesFor, stripDeliveryTags, GEMINI_DIRECT_CUES } from "../cues.js";
import { cleanTone, findFormat } from "../formats.js";
import { getPersona } from "../persona-store.js";
import { getStation } from "../station-profile-store.js";
import { listClips, saveClip } from "../store.js";
import { embedTags, sanitizeInfo } from "../clip-info.js";
import { sendToStation, stationConfigured } from "../station-send.js";
import { authorize, canView, ownerFor, type Principal } from "../auth.js";
import { stationOf, withKeys } from "../with-keys.js";
import { chargeAi, checkCount } from "../quota.js";
import { createLogger } from "../log.js";
import { elevenConfigured, isElevenModel } from "../elevenlabs.js";
import type { GenerateRequest, ClipMetadata } from "../types.js";

const log = createLogger("generate");

// Chips Voice scripts can contain [sfx:name] sound effect tags. This Gemini path cannot mix them, and Gemini
// would read them aloud, so they are removed (use the station's /speak to get the effects mixed in).
const SFX_TAG = /\[\s*sfx\s*:[^\]]*\]/gi;
export function stripSfxTags(text: string): { text: string; removed: boolean } {
  const removed = new RegExp(SFX_TAG.source, "i").test(text);
  return { text: removed ? text.replace(SFX_TAG, " ").replace(/\s{2,}/g, " ").trim() : text, removed };
}

export async function handleGenerate(req: Request): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // The person's own AI key beats the station's, which beats the site's (lib/credentials.ts); the station may also limit the models.
  return withKeys(who, await stationOf(req), () => generate(req, who));
}

async function generate(req: Request, who: Principal): Promise<Response> {
  let body: GenerateRequest;
  try {
    body = (await req.json()) as GenerateRequest;
  } catch {
    return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  }

  const { mode } = body;
  if (mode !== "say" && mode !== "ai") {
    return Response.json({ error: 'mode must be "say" or "ai"' }, { status: 400 });
  }

  const input = mode === "say" ? body.text : body.prompt;
  if (!input?.trim()) {
    return Response.json(
      { error: mode === "say" ? 'text is required for mode "say"' : 'prompt is required for mode "ai"' },
      { status: 400 },
    );
  }

  const provider = activeProvider();
  if (!provider) return Response.json({ error: NO_PROVIDER_MESSAGE }, { status: 503 });
  const over = await chargeAi(who);
  if (over) return over;

  // The station this is for: its name and tagline shape AI-written lines, and its defaults fill in what the request leaves out.
  let station;
  if (body.station !== undefined) {
    if (typeof body.station !== "string") return Response.json({ error: "station must be an id" }, { status: 400 });
    station = await getStation(body.station);
    if (!station) return Response.json({ error: `Unknown station "${body.station.slice(0, 50)}"` }, { status: 400 });
  }
  let persona;
  const personaId = body.persona !== undefined ? body.persona : station?.defaultPersonaId || undefined;
  if (personaId !== undefined) {
    if (typeof personaId !== "string") return Response.json({ error: "persona must be an id" }, { status: 400 });
    persona = await getPersona(personaId);
    if (!persona || !canView(who, persona.ownerId)) return Response.json({ error: `Unknown persona "${personaId.slice(0, 50)}"` }, { status: 400 });
  }

  const tone = cleanTone(body.tone ?? persona?.tone);
  if (body.tone !== undefined && typeof body.tone !== "string") {
    return Response.json({ error: "tone must be text" }, { status: 400 });
  }
  const format = body.format ? findFormat(body.format) : undefined;
  if (body.format && !format) {
    return Response.json({ error: `Unknown format "${String(body.format).slice(0, 40)}"` }, { status: 400 });
  }
  const voice = typeof body.voice === "string" ? body.voice.trim().slice(0, 60) : persona?.voice || station?.defaultVoice;

  // Models can be chosen per request only when OpenRouter is the provider.
  let textModel: string | undefined;
  let speechModel: SpeechModel | undefined;
  if (provider === "openrouter") {
    await ensureListed(typeof body.textModel === "string" ? body.textModel : undefined);
    const t = resolveTextModel(typeof body.textModel === "string" ? body.textModel : undefined, [persona?.textModel, station?.defaultTextModel]);
    if ("error" in t) return Response.json({ error: t.error }, { status: 400 });
    const requestedSpeech = typeof body.speechModel === "string" ? body.speechModel : persona?.speechModel || station?.defaultSpeechModel;
    // Models OpenRouter lists but the configured list lacks are looked up only when asked for.
    const listed = !requestedSpeech || speechModels().some((m) => m.id === requestedSpeech);
    const sp = pickSpeechModel(requestedSpeech, listed ? [] : await discoverSpeechModels());
    if ("error" in sp) return Response.json({ error: sp.error }, { status: 400 });
    textModel = t.model;
    speechModel = sp.model;
  } else if (!body.textModel && isElevenModel(typeof body.speechModel === "string" ? body.speechModel : persona?.speechModel || station?.defaultSpeechModel) && elevenConfigured()) {
    // Gemini writes, ElevenLabs speaks (voice clones): the only model choice that works without OpenRouter.
    speechModel = { id: (typeof body.speechModel === "string" ? body.speechModel : persona?.speechModel || station?.defaultSpeechModel)! };
  } else if (body.textModel || body.speechModel) {
    return Response.json({ error: "Choosing models needs OPENROUTER_API_KEY; this site is using Gemini directly" }, { status: 400 });
  }

  let scriptText: string;
  try {
    scriptText = mode === "ai" ? (await writeScript({ prompt: input, provider, textModel, tone, format, persona: persona?.instructions, explicit: body.explicit === true, ...(station ? { station: { name: station.name, tagline: station.tagline } } : {}) })).text : input;
  } catch (err) {
    log.error("script generation failed", { provider, textModel, err });
    return Response.json({ error: `Script generation failed: ${(err as Error).message}` }, { status: 502 });
  }

  // The writing step on its own: nothing is spoken, stored or sent anywhere.
  if (body.textOnly === true) {
    if (mode !== "ai") return Response.json({ error: 'textOnly needs mode "ai"' }, { status: 400 });
    return Response.json({ textOnly: true, scriptText, provider, ...(textModel ? { textModel } : {}) });
  }

  const stripped = stripSfxTags(scriptText);
  if (stripped.removed) scriptText = stripped.text;
  if (!scriptText) {
    return Response.json({ error: "The text contains only sound effect tags; add some words to speak" }, { status: 400 });
  }

  // Inline cues like [laughs] are only performed by some models; others would read the brackets aloud.
  const cues = provider === "openrouter" || isElevenModel(speechModel?.id) ? cuesFor((speechModel ?? defaultSpeechModel()).id) : GEMINI_DIRECT_CUES;
  let cueTagsRemoved = false;
  if (cues.tags === false) {
    const plain = stripDeliveryTags(scriptText);
    cueTagsRemoved = plain.removed;
    if (plain.removed) scriptText = plain.text;
    if (!scriptText) return Response.json({ error: "The text contains only delivery tags; add some words to speak" }, { status: 400 });
  }
  const toneIgnored = Boolean(tone) && cues.tone === "none";

  let spoken;
  try {
    spoken = await speak({ text: scriptText, provider, speechModel, voice, tone });
  } catch (err) {
    log.error("speech synthesis failed", { provider, speechModel, voice, err });
    return Response.json({ error: `Speech synthesis failed: ${(err as Error).message}` }, { status: 502 });
  }

  if (body.preview === true) {
    return Response.json({
      preview: true, scriptText, audio: spoken.audio.toString("base64"), mimeType: spoken.mimeType, voice: spoken.voice, provider, speechModel: spoken.model,
      ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed ? { sfxTagsRemoved: true } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}),
    });
  }

  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const info = sanitizeInfo({ title: scriptText.slice(0, 60), source: "generate", ...(persona ? { persona: persona.id } : {}), ...(station && station.id !== "default" ? { station: station.id } : {}), ...(format ? { kind: format.id } : {}), ...(body.info && typeof body.info === "object" ? body.info : {}) });
  const audio = embedTags(spoken.audio, spoken.mimeType, info, { script: scriptText, createdAt, clipId: id, station: process.env.STATION_NAME });
  const metadata: ClipMetadata = {
    id,
    ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}),
    createdAt,
    mode,
    input,
    scriptText,
    voice: spoken.voice,
    mimeType: spoken.mimeType,
    byteSize: audio.length,
    info,
    provider,
    speechModel: spoken.model,
    ...(mode === "ai" && textModel ? { textModel } : {}),
    ...(tone ? { tone } : {}),
    ...(format ? { format: format.id } : {}),
  };

  const full = await checkCount(who, "maxClips", async () => (await listClips()).filter((c) => c.ownerId === who.username).length);
  if (full) return full;
  await saveClip(id, audio, metadata);

  // Hand the clip to the station server when one is configured. A failure here is reported but does not
  // fail the request: the clip is already generated and stored.
  let handoff;
  if (body.handoff !== false && stationConfigured()) {
    handoff = await sendToStation({ clipId: id, audio, mimeType: spoken.mimeType, title: scriptText, info, station, play: body.play, preempt: body.preempt, fx: body.fx });
  }

  return Response.json(
    { id, scriptText, audioUrl: `/api/clips/${id}`, provider, speechModel: spoken.model, ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed ? { sfxTagsRemoved: true } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}), ...(handoff ? { handoff } : {}) },
    { status: 201 },
  );
}
