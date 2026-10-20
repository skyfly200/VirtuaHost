import { randomUUID } from "node:crypto";
import { activeProvider, writeScript, speak, NO_PROVIDER_MESSAGE } from "../ai.js";
import { pickTextModel, pickSpeechModel, speechModels, defaultSpeechModel, discoverSpeechModels, type SpeechModel } from "../openrouter.js";
import { cuesFor, stripDeliveryTags, GEMINI_DIRECT_CUES } from "../cues.js";
import { cleanTone, findFormat } from "../formats.js";
import { getPersona } from "../persona-store.js";
import { saveClip } from "../store.js";
import { handoffConfigured, handoffDefaults, pushToStation } from "../handoff.js";
import { checkAuth } from "../auth.js";
import type { GenerateRequest, ClipMetadata } from "../types.js";

// Chips Voice scripts can contain [sfx:name] sound effect tags. This Gemini path cannot mix them, and Gemini
// would read them aloud, so they are removed (use the station's /speak to get the effects mixed in).
const SFX_TAG = /\[\s*sfx\s*:[^\]]*\]/gi;
export function stripSfxTags(text: string): { text: string; removed: boolean } {
  const removed = new RegExp(SFX_TAG.source, "i").test(text);
  return { text: removed ? text.replace(SFX_TAG, " ").replace(/\s{2,}/g, " ").trim() : text, removed };
}

export async function handleGenerate(req: Request): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

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

  let persona;
  if (body.persona !== undefined) {
    if (typeof body.persona !== "string") return Response.json({ error: "persona must be an id" }, { status: 400 });
    persona = await getPersona(body.persona);
    if (!persona) return Response.json({ error: `Unknown persona "${body.persona.slice(0, 50)}"` }, { status: 400 });
  }

  const tone = cleanTone(body.tone ?? persona?.tone);
  if (body.tone !== undefined && typeof body.tone !== "string") {
    return Response.json({ error: "tone must be text" }, { status: 400 });
  }
  const format = body.format ? findFormat(body.format) : undefined;
  if (body.format && !format) {
    return Response.json({ error: `Unknown format "${String(body.format).slice(0, 40)}"` }, { status: 400 });
  }
  const voice = typeof body.voice === "string" ? body.voice.trim().slice(0, 60) : persona?.voice;

  // Models can be chosen per request only when OpenRouter is the provider.
  let textModel: string | undefined;
  let speechModel: SpeechModel | undefined;
  if (provider === "openrouter") {
    const t = pickTextModel(typeof body.textModel === "string" ? body.textModel : undefined);
    if ("error" in t) return Response.json({ error: t.error }, { status: 400 });
    const requestedSpeech = typeof body.speechModel === "string" ? body.speechModel : persona?.speechModel;
    // Models OpenRouter lists but the configured list lacks are looked up only when asked for.
    const listed = !requestedSpeech || speechModels().some((m) => m.id === requestedSpeech);
    const sp = pickSpeechModel(requestedSpeech, listed ? [] : await discoverSpeechModels());
    if ("error" in sp) return Response.json({ error: sp.error }, { status: 400 });
    textModel = t.model;
    speechModel = sp.model;
  } else if (body.textModel || body.speechModel) {
    return Response.json({ error: "Choosing models needs OPENROUTER_API_KEY; this site is using Gemini directly" }, { status: 400 });
  }

  let scriptText: string;
  try {
    scriptText = mode === "ai" ? (await writeScript({ prompt: input, provider, textModel, tone, format, persona: persona?.instructions })).text : input;
  } catch (err) {
    return Response.json({ error: `Script generation failed: ${(err as Error).message}` }, { status: 502 });
  }

  const stripped = stripSfxTags(scriptText);
  if (stripped.removed) scriptText = stripped.text;
  if (!scriptText) {
    return Response.json({ error: "The text contains only sound effect tags; add some words to speak" }, { status: 400 });
  }

  // Inline cues like [laughs] are only performed by some models; others would read the brackets aloud.
  const cues = provider === "openrouter" ? cuesFor((speechModel ?? defaultSpeechModel()).id) : GEMINI_DIRECT_CUES;
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
    return Response.json({ error: `Speech synthesis failed: ${(err as Error).message}` }, { status: 502 });
  }

  if (body.preview === true) {
    return Response.json({
      preview: true, scriptText, audio: spoken.audio.toString("base64"), mimeType: spoken.mimeType, voice: spoken.voice, provider, speechModel: spoken.model,
      ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed ? { sfxTagsRemoved: true } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}),
    });
  }

  const id = randomUUID();
  const metadata: ClipMetadata = {
    id,
    createdAt: new Date().toISOString(),
    mode,
    input,
    scriptText,
    voice: spoken.voice,
    mimeType: spoken.mimeType,
    byteSize: spoken.audio.length,
    provider,
    speechModel: spoken.model,
    ...(mode === "ai" && textModel ? { textModel } : {}),
    ...(tone ? { tone } : {}),
    ...(format ? { format: format.id } : {}),
  };

  await saveClip(id, spoken.audio, metadata);

  // Hand the clip to the station server when one is configured. A failure here is reported but does not
  // fail the request: the clip is already generated and stored.
  let handoff;
  if (body.handoff !== false && handoffConfigured()) {
    const defaults = handoffDefaults();
    handoff = await pushToStation(spoken.audio, {
      contentType: spoken.mimeType,
      title: scriptText,
      text: scriptText,
      play: body.play ?? defaults.play,
      preempt: body.preempt ?? defaults.preempt,
      fx: body.fx ?? defaults.fx,
    });
  }

  return Response.json(
    { id, scriptText, audioUrl: `/api/clips/${id}`, provider, speechModel: spoken.model, ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed ? { sfxTagsRemoved: true } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}), ...(handoff ? { handoff } : {}) },
    { status: 201 },
  );
}
