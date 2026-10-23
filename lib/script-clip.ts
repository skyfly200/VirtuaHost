// Speaking a script: each line is spoken with its speaker's voice (their persona's voice, tone and speech model, unless the cast entry overrides
// them), the lines are joined into one clip (lib/audio-join.ts), and the result can be saved like any other clip. Used by POST /api/generate
// (mode "script"), schedules, and the hub's dynamic slots.
import { randomUUID } from "node:crypto";
import { embedTags, sanitizeInfo, type ClipInfo } from "./clip-info.js";
import { joinAudio } from "./audio-join.js";
import { speakText } from "./make-clip.js";
import { saveClip } from "./store.js";
import type { Persona } from "./personas.js";
import type { Station } from "./station-profile.js";
import type { TemplateContext } from "./drop-template.js";
import { linesOf, MAX_LINES, type Script } from "./scripts.js";
import type { ClipMetadata } from "./types.js";

export interface RenderInput {
  script: Pick<Script, "kind" | "cast" | "text" | "gapSeconds">;
  /** The text to speak when it differs from the saved one (filled in, or freshly drafted). */
  text?: string;
  personas: Map<string, Persona>;
  station?: Station | null;
  templateContext?: TemplateContext;
  concurrency?: number;
}
export type Rendered = { ok: true; audio: Buffer; mimeType: string; gapApplied: boolean; lines: number; scriptText: string; speechModels: string[] } | { ok: false; status: number; error: string };

export async function renderScript(input: RenderInput): Promise<Rendered> {
  const lines = linesOf(input.script, input.text ?? input.script.text);
  if (!lines.length) return { ok: false, status: 400, error: "The script has nothing to say" };
  if (lines.length > MAX_LINES) return { ok: false, status: 400, error: `A script can have at most ${MAX_LINES} lines` };
  const stray = lines.find((l) => !l.member && input.script.kind === "conversation");
  if (stray) return { ok: false, status: 400, error: `"${stray.speaker}" is not in the cast` };
  const results: Array<Awaited<ReturnType<typeof speakText>>> = new Array(lines.length);
  let next = 0; let failed: Rendered | null = null;
  const worker = async () => {
    while (!failed) {
      const i = next++; if (i >= lines.length) return;
      const m = lines[i].member; const persona = m?.personaId ? input.personas.get(m.personaId) : undefined;
      const r = await speakText({
        text: lines[i].text, tone: persona?.tone, voice: m?.voice || persona?.voice || input.station?.defaultVoice,
        speechModel: m?.speechModel || persona?.speechModel || input.station?.defaultSpeechModel, templateContext: { ...(input.templateContext ?? {}), persona: persona ?? input.templateContext?.persona ?? null },
      });
      results[i] = r;
      if (!r.ok) failed = { ok: false, status: r.status, error: `${lines.length > 1 ? `Line ${i + 1} (${lines[i].speaker}): ` : ""}${r.error}` };
    }
  };
  await Promise.all(Array.from({ length: Math.min(input.concurrency ?? 3, lines.length) }, worker));
  if (failed) return failed;
  const ok = results as Array<Extract<typeof results[number], { ok: true }>>;
  try {
    const joined = joinAudio(ok.map((r) => ({ audio: r.spoken.audio, mimeType: r.spoken.mimeType })), input.script.gapSeconds);
    const spoken = ok.map((r, i) => (input.script.kind === "single" ? r.scriptText : `${lines[i].speaker}: ${r.scriptText}`)).join("\n");
    return { ok: true, audio: joined.audio, mimeType: joined.mimeType, gapApplied: joined.gapApplied, lines: lines.length, scriptText: spoken, speechModels: [...new Set(ok.map((r) => r.spoken.model))] };
  } catch (err) {
    return { ok: false, status: 422, error: (err as Error).message };
  }
}

export type SavedScriptClip = { ok: true; id: string; scriptText: string; mimeType: string } | { ok: false; status: number; error: string };

/** Renders and saves the result as a clip (so a schedule or the library can use it). */
export async function makeScriptClip(input: RenderInput & { input: string; info?: ClipInfo; ownerId?: string; textModel?: string }): Promise<SavedScriptClip> {
  const r = await renderScript(input);
  if (!r.ok) return r;
  return { ...(await saveRendered(r, input)), };
}

export async function saveRendered(r: Extract<Rendered, { ok: true }>, o: { input: string; info?: ClipInfo; ownerId?: string; textModel?: string }): Promise<{ ok: true; id: string; scriptText: string; mimeType: string }> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const info = sanitizeInfo({ title: r.scriptText.replace(/\n/g, " ").slice(0, 60), source: "script", kind: r.lines > 1 ? "conversation" : undefined, ...(o.info ?? {}) });
  const audio = embedTags(r.audio, r.mimeType, info, { script: r.scriptText, createdAt, clipId: id, station: process.env.STATION_NAME });
  const metadata: ClipMetadata = { id, ...(o.ownerId ? { ownerId: o.ownerId } : {}), createdAt, mode: "script", input: o.input.slice(0, 2000), scriptText: r.scriptText, voice: "", mimeType: r.mimeType, byteSize: audio.length, speechModel: r.speechModels.join(", "), info, ...(o.textModel ? { textModel: o.textModel } : {}) };
  await saveClip(id, audio, metadata);
  return { ok: true, id, scriptText: r.scriptText, mimeType: r.mimeType };
}
