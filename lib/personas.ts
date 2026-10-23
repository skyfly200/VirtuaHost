// Host personas: who is speaking. A persona gives the AI writer its character and can carry default delivery (tone, voice,
// speech model), plus ready-made link templates and station IDs to start from. Stored in Netlify Blobs
// (lib/persona-store.ts); CHIP ships built in and read-only (duplicate it to change it).

export interface Persona {
  id: string;
  /** Output only: an example persona (built in) that an admin has changed. Reset (DELETE) brings the original back. */
  edited?: boolean;
  /** Username of the owner. Unset = shared (built-ins and admin-made); only admins change those. */
  ownerId?: string;
  name: string;
  /** One line for lists. */
  description: string;
  /** The character brief given to the writing model. */
  instructions: string;
  tone: string;
  voice?: string;
  speechModel?: string;
  /** The writing model that plays this persona (AI-written lines, host links, promos). Falls back to the station's, then the site's default. */
  textModel?: string;
  /** Example lines with {artist} / {title}, usable as "say verbatim" text or as examples of the voice. */
  templates: string[];
  stationIds: string[];
  /** One emoji shown on the persona's card. */
  emoji?: string;
  /** Vibe and genre words, for finding and filtering ("jazz", "grumpy", "morning"). */
  tags: string[];
  /** The persona's catchphrase or slogan. */
  tagline?: string;
  /** A line added to a link at different times of day. */
  timeLines?: { morning?: string; afternoon?: string; evening?: string; night?: string };
  /** Promo and event lines. */
  promos: string[];
  /** Ways to end a show or a break. */
  signOffs: string[];
  builtin?: boolean;
  updatedAt?: string;
}

export const ID = /^[a-z0-9][a-z0-9-]{0,49}$/;
export const INSTRUCTIONS_MAX = 1500;
const LIMITS = { name: 60, description: 300, instructions: INSTRUCTIONS_MAX, tone: 100, voice: 60, speechModel: 100, line: 300, templates: 20, stationIds: 10, promos: 10, signOffs: 10, tags: 8, tag: 24, tagline: 120, emoji: 8 };

export { EXAMPLE_PERSONAS as BUILTIN_PERSONAS } from "./persona-library.js";

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max) : "";
const lines = (value: unknown, count: number): string[] =>
  Array.isArray(value) ? value.map((v) => clean(v, LIMITS.line)).filter(Boolean).slice(0, count) : [];

export const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Cleans user or AI supplied fields into a persona (without an id). Returns an error message when it cannot be one.
// `lenient` is for an AI-drafted persona that is only shown for editing: a long brief is cut at the last full sentence that fits instead of refused.
export function sanitizePersona(raw: unknown, options: { lenient?: boolean } = {}): { persona: Omit<Persona, "id"> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Send the persona as a JSON object" };
  const r = raw as Record<string, unknown>;
  const name = clean(r.name, LIMITS.name);
  if (!name) return { error: "A persona needs a name" };
  let instructions = clean(r.instructions, 100_000);
  if (instructions.length > INSTRUCTIONS_MAX) {
    if (!options.lenient) return { error: `The instructions are ${instructions.length} characters; the limit is ${INSTRUCTIONS_MAX}. Shorten them by ${instructions.length - INSTRUCTIONS_MAX} characters (nothing was saved).` };
    const cut = instructions.slice(0, INSTRUCTIONS_MAX);
    const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    instructions = end > INSTRUCTIONS_MAX / 2 ? cut.slice(0, end + 1) : cut;
  }
  if (!instructions) return { error: "A persona needs instructions (who they are and how they talk)" };
  const voice = clean(r.voice, LIMITS.voice);
  const speechModel = clean(r.speechModel, LIMITS.speechModel);
  const textModel = clean(r.textModel, LIMITS.speechModel);
  const emoji = clean(r.emoji, LIMITS.emoji);
  const tagline = clean(r.tagline, LIMITS.tagline);
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.map((t) => clean(t, LIMITS.tag).toLowerCase()).filter(Boolean))].slice(0, LIMITS.tags) : [];
  const tl = (r.timeLines && typeof r.timeLines === "object" ? r.timeLines : {}) as Record<string, unknown>;
  const timeLines: NonNullable<Persona["timeLines"]> = {};
  for (const part of ["morning", "afternoon", "evening", "night"] as const) {
    const line = clean(tl[part], LIMITS.line);
    if (line) timeLines[part] = ` ${line}`;
  }
  return {
    persona: {
      ...(emoji ? { emoji } : {}),
      ...(tagline ? { tagline } : {}),
      tags,
      promos: lines(r.promos, LIMITS.promos),
      signOffs: lines(r.signOffs, LIMITS.signOffs),
      ...(Object.keys(timeLines).length ? { timeLines } : {}),
      name,
      description: clean(r.description, LIMITS.description),
      instructions,
      tone: clean(r.tone, LIMITS.tone),
      ...(voice ? { voice } : {}),
      ...(speechModel ? { speechModel } : {}),
      ...(textModel ? { textModel } : {}),
      templates: lines(r.templates, LIMITS.templates),
      stationIds: lines(r.stationIds, LIMITS.stationIds),
    },
  };
}

// ----- asking the writing model to draft a persona -----
export const PERSONA_SYSTEM_PROMPT =
  "You design on-air host personas for an online radio station. Reply with ONLY a JSON object, no prose and no code fences, with these keys: " +
  '"name" (short), "description" (one sentence), "instructions" (2 to 5 sentences written to the AI that will play this host: who they are, how they speak, ' +
  "what they call listeners, what to avoid, always ending with a reminder to keep each link to one or two short sentences and never claim to be a real person), " +
  '"tone" (a few comma-separated delivery words, under 100 characters), "emoji" (one emoji), "tags" (3 to 5 lowercase vibe or genre words), "tagline" (a short slogan), ' +
  '"templates" (6 short example song-link lines using {artist} and {title}), "stationIds" (3 short station ID lines), "promos" (2 short promo lines), ' +
  '"signOffs" (2 short sign-off lines) and "timeLines" (an object with a short sentence for each of morning, afternoon, evening and night). Lines may use {station} for the station name. ' +
  "Spoken words only in the lines: no stage directions, emoji or markdown.";

export function personaPrompt(description: string, station: string): string {
  return `Station: ${station}\nThe host I want: ${description}`;
}

// The model's reply as a persona draft. Tolerates code fences or a sentence around the JSON.
export function parsePersonaReply(reply: string): { persona: Omit<Persona, "id"> } | { error: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "The model did not return a persona. Try again, or add more detail to the description." };
  try {
    return sanitizePersona(JSON.parse(reply.slice(start, end + 1)), { lenient: true });
  } catch {
    return { error: "The model's reply was not valid JSON. Try again." };
  }
}

// Personas saved before tags, promos and sign-offs existed still load: the missing lists are empty.
export const normalizePersona = (p: Persona): Persona => ({ ...p, tags: p.tags ?? [], promos: p.promos ?? [], signOffs: p.signOffs ?? [] });
