import { randomUUID } from "node:crypto";
import { writeDjLine, synthesizeSpeech, DEFAULT_VOICE } from "../gemini.js";
import { pcmToWav } from "../wav.js";
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

  let scriptText: string;
  try {
    scriptText = mode === "ai" ? await writeDjLine(input) : input;
  } catch (err) {
    return Response.json({ error: `Script generation failed: ${(err as Error).message}` }, { status: 502 });
  }

  const stripped = stripSfxTags(scriptText);
  if (stripped.removed) scriptText = stripped.text;
  if (!scriptText) {
    return Response.json({ error: "The text contains only sound effect tags; add some words to speak" }, { status: 400 });
  }

  let pcm: Buffer;
  let mimeType: string;
  try {
    ({ pcm, mimeType } = await synthesizeSpeech(scriptText));
  } catch (err) {
    return Response.json({ error: `Speech synthesis failed: ${(err as Error).message}` }, { status: 502 });
  }
  void mimeType; // Gemini's inline mimeType describes the raw PCM; the stored file is always audio/wav.

  const wav = pcmToWav(pcm);
  const id = randomUUID();
  const metadata: ClipMetadata = {
    id,
    createdAt: new Date().toISOString(),
    mode,
    input,
    scriptText,
    voice: process.env.GEMINI_TTS_VOICE ?? DEFAULT_VOICE,
    mimeType: "audio/wav",
    byteSize: wav.length,
  };

  await saveClip(id, wav, metadata);

  // Hand the clip to the station server when one is configured. A failure here is reported but does not
  // fail the request: the clip is already generated and stored.
  let handoff;
  if (body.handoff !== false && handoffConfigured()) {
    const defaults = handoffDefaults();
    handoff = await pushToStation(wav, {
      title: scriptText,
      text: scriptText,
      play: body.play ?? defaults.play,
      preempt: body.preempt ?? defaults.preempt,
      fx: body.fx ?? defaults.fx,
    });
  }

  return Response.json(
    { id, scriptText, audioUrl: `/api/clips/${id}`, ...(stripped.removed ? { sfxTagsRemoved: true } : {}), ...(handoff ? { handoff } : {}) },
    { status: 201 },
  );
}
