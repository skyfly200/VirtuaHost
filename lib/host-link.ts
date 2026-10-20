import { activeProvider, complete } from "./ai.js";
import { cleanLink, LINK_SYSTEM_PROMPT, linkPrompt, templateLine, type HostConfig } from "./host.js";
import { makeClip, type MadeClip } from "./make-clip.js";
import { getPersona } from "./persona-store.js";
import { pickTextModel } from "./openrouter.js";

// Writes the link for a track: the persona's example lines, or the writing model (falling back to a template when it fails).
export async function composeLink(artist: string, title: string, config: HostConfig, now = new Date(), rng: () => number = Math.random): Promise<{ text: string; source: "template" | "llm"; note?: string }> {
  const station = process.env.STATION_NAME || "the station";
  const persona = config.personaId ? await getPersona(config.personaId) : null;
  const provider = activeProvider();
  let note: string | undefined;
  if (config.lines === "llm" && provider) {
    try {
      const textModel = provider === "openrouter" ? (pickTextModel(undefined) as { model: string }).model : undefined;
      const out = cleanLink(await complete({ system: LINK_SYSTEM_PROMPT(station, persona?.instructions), prompt: linkPrompt(artist, title, now.getHours()), provider, textModel }));
      if (out) return { text: out, source: "llm" };
    } catch (err) {
      note = `The writing model failed, so a template was used: ${(err as Error).message}`.slice(0, 200);
    }
  }
  return { text: templateLine({ artist, title, station, hour: now.getHours(), rng, templates: persona?.templates }), source: "template", ...(note ? { note } : {}) };
}

// Writes and voices the link, saving it as a clip. The station daemon plays it.
export async function makeHostLink(artist: string, title: string, config: HostConfig): Promise<(MadeClip & { ok: true; source: "template" | "llm"; note?: string }) | Extract<MadeClip, { ok: false }>> {
  const persona = config.personaId ? await getPersona(config.personaId) : null;
  const line = await composeLink(artist, title, config);
  const made = await makeClip({
    text: line.text, input: `host link: ${artist} - ${title}`, mode: line.source === "llm" ? "ai" : "say", format: "host-link",
    tone: config.tone || persona?.tone, voice: config.voice || persona?.voice, speechModel: config.speechModel || persona?.speechModel,
  });
  return made.ok ? { ...made, source: line.source, ...(line.note ? { note: line.note } : {}) } : made;
}
