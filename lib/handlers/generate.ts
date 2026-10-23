import { randomUUID } from "node:crypto";
import { activeProvider, writeScript, speak, NO_PROVIDER_MESSAGE } from "../ai.js";
import { ensureListed, resolveTextModel, pickSpeechModel, speechModels, defaultSpeechModel, discoverSpeechModels, type SpeechModel } from "../openrouter.js";
import { cuesFor, stripDeliveryTags, GEMINI_DIRECT_CUES } from "../cues.js";
import { cleanTone, findFormat } from "../formats.js";
import { getPersona } from "../persona-store.js";
import { getStation } from "../station-profile-store.js";
import type { Station } from "../station-profile.js";
import type { Persona } from "../personas.js";
import { listClips, saveClip } from "../store.js";
import { embedTags, sanitizeInfo } from "../clip-info.js";
import { sendToStation, stationConfigured } from "../station-send.js";
import { authorize, canView, ownerFor, type Principal } from "../auth.js";
import { stationOf, withKeys } from "../with-keys.js";
import { chargeAi, checkCount } from "../quota.js";
import { createLogger } from "../log.js";
import { contextFor, promptHelp, renderTemplate } from "../drop-template.js";
import { elevenConfigured, isElevenModel } from "../elevenlabs.js";
import { copiedExample, exampleLines } from "../copy-guard.js";
import { renderScript, saveRendered } from "../script-clip.js";
import { canMix, effectNames, hasTags, sfxHelp, speakMixed } from "../sfx-mix.js";
import { getScript } from "../script-store.js";
import { linesOf, sanitizeCast, type Script } from "../scripts.js";
import { recordModelResult } from "../model-health.js";
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
  const { who, denied } = await authorize(req, { scope: "generate" });
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
  if (mode === "script") return generateScript(who, body);
  if (mode !== "say" && mode !== "ai") {
    return Response.json({ error: 'mode must be "say", "ai" or "script"' }, { status: 400 });
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
  let station: Station | null | undefined;
  if (body.station !== undefined) {
    if (typeof body.station !== "string") return Response.json({ error: "station must be an id" }, { status: 400 });
    station = await getStation(body.station);
    if (!station) return Response.json({ error: `Unknown station "${body.station.slice(0, 50)}"` }, { status: 400 });
  }
  let persona: Persona | null | undefined;
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

  // Placeholders like {{time}} or {{weather}} are filled in by the engine after the words are written and before they are spoken.
  const targetSeconds = typeof body.seconds === "number" && body.seconds >= 3 && body.seconds <= 90 ? Math.round(body.seconds) : undefined;
  // `at`: the moment the line will be heard, for lines written a few minutes before they air (just-in-time drops). Ignored when it is not within
  // the next 3 hours (or the last 5 minutes), so a wrong value can never put the wrong time on air.
  const atMs = typeof body.at === "string" ? Date.parse(body.at) : NaN;
  const hearAt = Number.isFinite(atMs) && atMs - Date.now() <= 3 * 3600e3 && atMs - Date.now() >= -5 * 60e3 ? new Date(atMs) : undefined;
  const tctx = contextFor({ station, persona, targetSeconds, ...(hearAt ? { now: hearAt } : {}) });

  // `sfx: true` lets the writer drop in sound effect tags (they are mixed in when the voice returns WAV, otherwise removed).
  const effects = body.sfx === true && mode === "ai" ? sfxHelp(await effectNames()) : undefined;

  let scriptText: string;
  // Models sometimes copy an example line from the persona's brief; one retry asks for something new, and if it is still a copy it is reported.
  const examples = persona ? exampleLines(persona.instructions, persona.templates) : [];
  let copied: string | undefined;
  try {
    const write = (prompt: string) => writeScript({ prompt, provider, textModel, tone, format, persona: persona?.instructions, explicit: body.explicit === true, placeholders: promptHelp(tctx), targetSeconds, ...(effects ? { effects } : {}), ...(station ? { station: { name: station.name, tagline: station.tagline } } : {}) });
    if (mode === "ai") {
      let out = await write(input);
      copied = copiedExample(out.text, examples);
      if (copied) {
        out = await write(`${input}\n\n(Your last attempt repeated one of the example lines from your character brief. Write a completely different line in the same voice.)`);
        copied = copiedExample(out.text, examples);
      }
      scriptText = out.text;
      if (textModel) recordModelResult(textModel, true);
    } else scriptText = input;
  } catch (err) {
    if (textModel) recordModelResult(textModel, false, (err as Error).message);
    log.error("script generation failed", { provider, textModel, err });
    return Response.json({ error: `Script generation failed: ${(err as Error).message}` }, { status: 502 });
  }

  // Placeholders are filled in here, for every path, so no {{braces}} ever reach a person or the voice.
  const template = scriptText;
  const filled = await renderTemplate(scriptText, tctx);

  // The writing step on its own: nothing is spoken, stored or sent anywhere. `scriptText` is what would be said now; `template` is what the
  // writer wrote, with its {{placeholders}}, for anyone who wants to keep them (a schedule).
  if (body.textOnly === true) {
    if (mode !== "ai") return Response.json({ error: 'textOnly needs mode "ai"' }, { status: 400 });
    // `filledIn` is the line as it would be spoken now ({{time}} and friends filled in) and is the field to use. `raw` is the writer's version with its
    // {{placeholders}}. `scriptText` equals `filledIn` (kept for older callers); `template` is `raw`, only when it differs.
    return Response.json({
      textOnly: true, filledIn: filled.text, raw: template, scriptText: filled.text, ...(template !== filled.text ? { template } : {}), ...(filled.missing.length ? { templateMissing: filled.missing } : {}),
      ...(/\{\{[^}]*\}\}/.test(filled.text) ? { unresolvedPlaceholders: true } : {}), ...(copied ? { copiedExample: copied } : {}), provider, ...(textModel ? { textModel } : {}),
    });
  }

  scriptText = filled.text;
  if (filled.missing.length) log.warn("template values missing", { missing: filled.missing });
  if (!scriptText) return Response.json({ error: "The text is empty once the placeholders are filled in" }, { status: 400 });

  const tagged = scriptText;
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
  let sfx: { applied: string[]; skipped: string[] } | undefined;
  try {
    // Effect tags are mixed in when the voice returns WAV (lib/sfx-mix.ts); otherwise they were removed above and the response says so.
    const mixed = hasTags(tagged) && canMix(provider, speechModel?.id)
      ? await speakMixed(tagged, (words) => speak({ text: cues.tags === false ? stripDeliveryTags(words).text : words, provider, speechModel, voice, tone }))
      : null;
    if (mixed) { spoken = mixed.spoken; scriptText = mixed.scriptText; sfx = { applied: mixed.applied, skipped: mixed.skipped }; }
    else spoken = await speak({ text: scriptText, provider, speechModel, voice, tone });
  } catch (err) {
    log.error("speech synthesis failed", { provider, speechModel, voice, err });
    return Response.json({ error: `Speech synthesis failed: ${(err as Error).message}` }, { status: 502 });
  }

  if (body.preview === true) {
    return Response.json({
      preview: true, filledIn: scriptText, scriptText, audio: spoken.audio.toString("base64"), mimeType: spoken.mimeType, voice: spoken.voice, provider, speechModel: spoken.model,
      ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed && !sfx ? { sfxTagsRemoved: true } : {}), ...(sfx ? { sfx } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}), ...(filled.missing.length ? { templateMissing: filled.missing } : {}),
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
    { id, scriptText, audioUrl: `/api/clips/${id}`, provider, speechModel: spoken.model, ...(textModel && mode === "ai" ? { textModel } : {}), ...(stripped.removed && !sfx ? { sfxTagsRemoved: true } : {}), ...(sfx ? { sfx } : {}), ...(cueTagsRemoved ? { cueTagsRemoved: true } : {}), ...(toneIgnored ? { toneIgnored: true } : {}), ...(handoff ? { handoff } : {}) },
    { status: 201 },
  );
}

// mode "script": a saved script (scriptId) or an inline cast + text, spoken line by line in each speaker's voice and joined into one clip.
async function generateScript(who: Principal, body: GenerateRequest): Promise<Response> {
  let script: Pick<Script, "kind" | "cast" | "text" | "gapSeconds">;
  let name = "script";
  if (typeof body.scriptId === "string") {
    const saved = await getScript(body.scriptId);
    if (!saved || !canView(who, saved.ownerId)) return Response.json({ error: "Script not found" }, { status: 404 });
    script = typeof body.text === "string" && body.text.trim() ? { ...saved, text: body.text } : saved; name = saved.name;
  } else {
    const cast = sanitizeCast(body.cast);
    if ("error" in cast) return Response.json({ error: cast.error }, { status: 400 });
    if (typeof body.text !== "string" || !body.text.trim()) return Response.json({ error: "text is required for mode \"script\"" }, { status: 400 });
    script = { kind: cast.cast.length > 1 ? "conversation" : "single", cast: cast.cast, text: body.text, gapSeconds: Number.isFinite(Number(body.gapSeconds)) ? Math.min(3, Math.max(0, Number(body.gapSeconds))) : 0.3 };
  }
  if (!linesOf(script).length) return Response.json({ error: "The script has nothing to say" }, { status: 400 });
  if (!activeProvider()) return Response.json({ error: NO_PROVIDER_MESSAGE }, { status: 503 });
  let station = null;
  if (typeof body.station === "string") {
    station = await getStation(body.station);
    if (!station) return Response.json({ error: `Unknown station "${body.station.slice(0, 50)}"` }, { status: 400 });
  }
  const personas = new Map<string, Persona>();
  for (const c of script.cast) {
    if (!c.personaId || personas.has(c.personaId)) continue;
    const p = await getPersona(c.personaId);
    if (!p || !canView(who, p.ownerId)) return Response.json({ error: `Unknown persona "${c.personaId.slice(0, 50)}"` }, { status: 400 });
    personas.set(c.personaId, p);
  }
  const over = await chargeAi(who);
  if (over) return over;
  const atMs = typeof body.at === "string" ? Date.parse(body.at) : NaN;
  const hearAt = Number.isFinite(atMs) && atMs - Date.now() <= 3 * 3600e3 && atMs - Date.now() >= -5 * 60e3 ? new Date(atMs) : undefined;
  const rendered = await renderScript({ script, personas, station, templateContext: contextFor({ station, now: hearAt }) });
  if (!rendered.ok) return Response.json({ error: rendered.error }, { status: rendered.status });
  if (body.preview === true) {
    return Response.json({ preview: true, filledIn: rendered.scriptText, scriptText: rendered.scriptText, audio: rendered.audio.toString("base64"), mimeType: rendered.mimeType, lines: rendered.lines, gapApplied: rendered.gapApplied, speechModel: rendered.speechModels.join(", ") });
  }
  const info = sanitizeInfo({ ...(station && station.id !== "default" ? { station: station.id } : {}), ...(body.info && typeof body.info === "object" ? body.info : {}) });
  const saved = await saveRendered(rendered, { input: `script: ${name}`, info, ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}) });
  return Response.json({ id: saved.id, scriptText: saved.scriptText, audioUrl: `/api/clips/${saved.id}`, lines: rendered.lines }, { status: 201 });
}
