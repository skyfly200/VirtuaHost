// Saved scripts: a script is what gets said (one voice, or a conversation between up to four speakers) plus who says it. It can be written by hand,
// drafted by the AI from the cast's personas, saved, and reused: in the Voice Lab, in schedules, and in dynamic slots on the hub. Text may carry
// {{placeholders}} ({{time}}, {{station}}...); they are filled in each time the script is used, never when it is saved.
export const MAX_CAST = 4;
export const MAX_LINES = 40;
export const MAX_TEXT = 6000;
export const SPEAKER = /^[A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}$/;

export interface CastMember {
  /** The label used in the text: "Rocky: Hello." */
  name: string;
  personaId?: string;
  voice?: string;
  speechModel?: string;
  /** What this speaker does in the scene ("host", "skeptical caller"): told to the AI writer. */
  role?: string;
}

export type ScriptKind = "single" | "conversation";

export interface Script {
  id: string;
  /** Username of the owner. Unset = shared (made by an admin or the access key). */
  ownerId?: string;
  name: string;
  kind: ScriptKind;
  cast: CastMember[];
  /** What the AI is asked to write about. */
  topic: string;
  format?: string;
  /** About how long it should run, in seconds. */
  seconds?: number;
  text: string;
  /** Pause between lines of a conversation. */
  gapSeconds: number;
  stationId?: string;
  tags: string[];
  notes: string;
  createdAt?: string;
  updatedAt?: string;
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/[ \t]+/g, " ").trim().slice(0, max) : "");

/** "Name: line" per line; a line with no name continues the previous one. Same rule as the Voice Lab (public/shared/speaker.js). */
export function parseDialogue(text: string): Array<{ speaker: string; text: string }> {
  const lines: Array<{ speaker: string; text: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    // Writers often bold the label: "**Dale:** hi" or "**Dale**: hi". The asterisks are not part of the name.
    const raw = line.replace(/^\s*(?:\[[^\]]*\]\s*)+(?=\*{0,2}[A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}\*{0,2}\s*:)/, "").replace(/^(\s*)\*+\s*/, "$1").replace(/\*+(\s*:)/, "$1").replace(/(:\s*)\*+\s*/, "$1");
    const m = raw.match(/^\s*([A-Za-z0-9][A-Za-z0-9 _.'-]{0,23}?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/);
    if (m && m[2].trim()) lines.push({ speaker: m[1].trim(), text: m[2].trim() });
    else if (raw.trim() && lines.length) lines[lines.length - 1].text += ` ${raw.trim()}`;
  }
  return lines;
}

export const speakersOf = (text: string): string[] => [...new Set(parseDialogue(text).map((l) => l.speaker))];

export function sanitizeCast(raw: unknown): { cast: CastMember[] } | { error: string } {
  if (raw === undefined) return { cast: [] };
  if (!Array.isArray(raw)) return { error: "cast must be a list of speakers" };
  if (raw.length > MAX_CAST) return { error: `A script can have at most ${MAX_CAST} speakers (this one has ${raw.length}).` };
  const cast: CastMember[] = [];
  for (const item of raw) {
    const r = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const name = clean(r.name, 24);
    if (!SPEAKER.test(name)) return { error: `"${name.slice(0, 30)}" is not a usable speaker name (letters, numbers and spaces, up to 24; it cannot contain a colon).` };
    if (cast.some((c) => c.name.toLowerCase() === name.toLowerCase())) return { error: `Two speakers are both called "${name}": give each a different name.` };
    const personaId = clean(r.personaId, 60); const voice = clean(r.voice, 60); const speechModel = clean(r.speechModel, 100); const role = clean(r.role, 60);
    cast.push({ name, ...(personaId ? { personaId } : {}), ...(voice ? { voice } : {}), ...(speechModel ? { speechModel } : {}), ...(role ? { role } : {}) });
  }
  return { cast };
}

export function sanitizeScript(raw: unknown): { script: Omit<Script, "id"> } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Send the script as a JSON object" };
  const r = raw as Record<string, unknown>;
  const name = clean(r.name, 80);
  if (!name) return { error: "A script needs a name" };
  const kind: ScriptKind = r.kind === "conversation" ? "conversation" : "single";
  const castResult = sanitizeCast(r.cast);
  if ("error" in castResult) return castResult;
  const cast = castResult.cast;
  if (kind === "single" && cast.length > 1) return { error: "A single-voice script has one speaker; make it a conversation to use more." };
  if (kind === "conversation" && cast.length < 2) return { error: "A conversation needs at least two speakers." };
  const text = typeof r.text === "string" ? r.text.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").trim() : "";
  if (text.length > MAX_TEXT) return { error: `The script is ${text.length} characters; the limit is ${MAX_TEXT}. Shorten it by ${text.length - MAX_TEXT} (nothing was saved).` };
  if (kind === "conversation" && text) {
    const lines = parseDialogue(text);
    if (lines.length > MAX_LINES) return { error: `A conversation can have at most ${MAX_LINES} lines (this has ${lines.length}).` };
    const known = new Set(cast.map((c) => c.name.toLowerCase()));
    const stray = [...new Set(lines.map((l) => l.speaker).filter((s) => !known.has(s.toLowerCase())))];
    if (stray.length) return { error: `The text has lines from ${stray.map((s) => `"${s}"`).join(", ")}, who ${stray.length === 1 ? "is" : "are"} not in the cast. Add them to the cast or rename the lines.` };
  }
  const seconds = Number(r.seconds);
  const gap = Number(r.gapSeconds);
  const format = clean(r.format, 40);
  const stationId = clean(r.stationId, 60);
  const tags = Array.isArray(r.tags) ? [...new Set(r.tags.map((t) => clean(t, 24).toLowerCase()).filter(Boolean))].slice(0, 8) : [];
  return {
    script: {
      name, kind, cast, topic: clean(r.topic, 600), ...(format ? { format } : {}), ...(Number.isFinite(seconds) && seconds >= 3 && seconds <= 180 ? { seconds: Math.round(seconds) } : {}),
      text, gapSeconds: Number.isFinite(gap) ? Math.min(3, Math.max(0, gap)) : 0.3, ...(stationId ? { stationId } : {}), tags, notes: clean(r.notes, 1000),
    },
  };
}

/** The lines of a script with their cast member (a single-voice script is one line: the whole text, spoken by its one speaker). */
export function linesOf(script: Pick<Script, "kind" | "cast" | "text">, text = script.text): Array<{ speaker: string; text: string; member?: CastMember }> {
  if (script.kind === "single") return text.trim() ? [{ speaker: script.cast[0]?.name ?? "", text: text.trim(), member: script.cast[0] }] : [];
  const byName = new Map(script.cast.map((c) => [c.name.toLowerCase(), c]));
  return parseDialogue(text).map((l) => ({ ...l, member: byName.get(l.speaker.toLowerCase()) }));
}
