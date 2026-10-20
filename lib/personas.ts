// Host personas: who is speaking. A persona gives the AI writer its character and can carry default delivery (tone, voice,
// speech model), plus ready-made link templates and station IDs to start from. Stored in Netlify Blobs
// (lib/persona-store.ts); CHIP ships built in and read-only (duplicate it to change it).

export interface Persona {
  id: string;
  name: string;
  /** One line for lists. */
  description: string;
  /** The character brief given to the writing model. */
  instructions: string;
  tone: string;
  voice?: string;
  speechModel?: string;
  /** Example lines with {artist} / {title}, usable as "say verbatim" text or as examples of the voice. */
  templates: string[];
  stationIds: string[];
  builtin?: boolean;
  updatedAt?: string;
}

export const ID = /^[a-z0-9][a-z0-9-]{0,49}$/;
const LIMITS = { name: 60, description: 300, instructions: 1500, tone: 100, voice: 60, speechModel: 100, line: 300, templates: 20, stationIds: 10 };

export const BUILTIN_PERSONAS: Persona[] = [
  {
    id: "chip",
    name: "CHIP (Way High Radio)",
    description: "The old gravelly computer-captain of the haunted interdimensional pirate ship that carries Way High Radio.",
    tone: "weathered, grumbly old sailor, dry, secretly fond, slow and unhurried",
    instructions:
      "You are CHIP, the old gravelly computer-captain who runs the transmitter on the haunted interdimensional pirate ship carrying Way High Radio. " +
      "Speak slowly, grumble about the machinery and the fog, and be secretly fond of the crew and the music. Call listeners crew, shipmates or stowaways. " +
      "Keep each link to one or two short sentences. Use ship and signal language. Never claim to be a real person and never make factual claims about real regulators. " +
      'The tagline is "We\'re taking radio higher."',
    templates: [
      "That was {artist} with {title}. Smooth sailing. Mostly. The fog has been in the engine again.",
      "{artist}, {title}. Don't ask me how the signal got through. I stopped asking years ago.",
      "Ahoy, crew. That was {title} from {artist}. Next port: more music.",
      "Hmph. {artist}. Not bad. Don't tell the others I said that.",
    ],
    stationIds: [
      "This is Way High Radio. Broadcasting from a haunted ship adrift between dimensions. We are taking radio higher.",
      "CHIP here, at the helm of the signal. You are tuned in, so you are crew. Way High Radio.",
      "Don't touch that dial. The dial is cursed. Way High Radio.",
    ],
    builtin: true,
  },
];

const clean = (value: unknown, max: number): string =>
  typeof value === "string" ? value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max) : "";
const lines = (value: unknown, count: number): string[] =>
  Array.isArray(value) ? value.map((v) => clean(v, LIMITS.line)).filter(Boolean).slice(0, count) : [];

export const slugify = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Cleans user or AI supplied fields into a persona (without an id). Returns an error message when it cannot be one.
export function sanitizePersona(raw: unknown): { persona: Omit<Persona, "id"> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Send the persona as a JSON object" };
  const r = raw as Record<string, unknown>;
  const name = clean(r.name, LIMITS.name);
  if (!name) return { error: "A persona needs a name" };
  const instructions = clean(r.instructions, LIMITS.instructions);
  if (!instructions) return { error: "A persona needs instructions (who they are and how they talk)" };
  const voice = clean(r.voice, LIMITS.voice);
  const speechModel = clean(r.speechModel, LIMITS.speechModel);
  return {
    persona: {
      name,
      description: clean(r.description, LIMITS.description),
      instructions,
      tone: clean(r.tone, LIMITS.tone),
      ...(voice ? { voice } : {}),
      ...(speechModel ? { speechModel } : {}),
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
  '"tone" (a few comma-separated delivery words, under 100 characters), "templates" (6 short example song-link lines using {artist} and {title}), ' +
  '"stationIds" (3 short station ID lines). Spoken words only in the lines: no stage directions, emoji or markdown.';

export function personaPrompt(description: string, station: string): string {
  return `Station: ${station}\nThe host I want: ${description}`;
}

// The model's reply as a persona draft. Tolerates code fences or a sentence around the JSON.
export function parsePersonaReply(reply: string): { persona: Omit<Persona, "id"> } | { error: string } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "The model did not return a persona. Try again, or add more detail to the description." };
  try {
    return sanitizePersona(JSON.parse(reply.slice(start, end + 1)));
  } catch {
    return { error: "The model's reply was not valid JSON. Try again." };
  }
}
