// Turning a flier into a promo: read the event off the flier (a picture, or pasted text), fix the details, then write short
// spots about it in a persona's voice. The clip it becomes carries the event as metadata and expires when the event ends
// (lib/clip-info.ts), so it never airs after the night is over.
import { sanitizeEvent, type EventInfo } from "./clip-info.js";
import { validTimeZone, zonedToUtc } from "./schedule.js";

export const MAX_IMAGE_CHARS = 4_500_000;
export const IMAGE_URL = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const DEFAULT_LENGTH_MS = 3 * 3600_000;

// ----- reading the flier -----
export const READ_SYSTEM_PROMPT = (today: string, tz: string) =>
  "You read event fliers and posters for a radio station. Reply with ONLY a JSON object, no prose and no code fences, with these keys: " +
  '"name" (the event title), "startsAtLocal" (the start as local wall-clock time "YYYY-MM-DDTHH:mm", or ""), "endsAtLocal" (the end, or ""), ' +
  '"venue", "address", "price" (as written, for example "$10 at the door" or "free"), "performers" (an array of names), "url", "phone", ' +
  '"description" (one sentence, only what the flier says), and "notes" (an array of short remarks about anything unclear, missing or guessed). ' +
  `Today is ${today} in the time zone ${tz}: when the flier gives a date without a year, use the next occurrence of that date. ` +
  'Only report what is on the flier; use "" or [] for anything that is not there. Never invent a time, price or act.';

export function parseJsonObject(reply: string): Record<string, unknown> | null {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ----- event details: local wall-clock times -> instants -----
export interface FlierEvent extends EventInfo {
  /** What the person edits: the local wall-clock times they see on the flier, in `tz`. */
  startsAtLocal?: string;
  endsAtLocal?: string;
  tz: string;
  /** Set when the end was not on the flier and was assumed. */
  endGuessed?: boolean;
  /** The date and time as it should be spoken. */
  whenSpoken?: string;
  /** The moment the promo stops airing. */
  expiresAt?: string;
  notes?: string[];
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/;
function localToIso(local: unknown, tz: string): string | undefined {
  const m = typeof local === "string" ? LOCAL.exec(local.trim()) : null;
  if (!m) return undefined;
  const ms = zonedToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

const ORDINALS = ["", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth", "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth", "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth", "thirty-first"];
const NUMBERS = ["twelve", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven"];
const TEENS = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty"];
// 1-59 as the minutes of a clock time: "oh five", "fifteen", "forty-five".
const minuteWords = (m: number): string => (m < 10 ? `oh ${NUMBERS[m]}` : m < 20 ? TEENS[m - 10] : `${TENS[Math.floor(m / 10)]}${m % 10 ? `-${NUMBERS[m % 10]}` : ""}`);

// "Friday the twelfth of April at seven thirty p.m." (so a promo never says "tonight", which is wrong a day early).
export function spokenWhen(startsAt: string, tz: string): string {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(new Date(startsAt)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour); const minute = Number(p.minute);
  const clock = hour === 12 && minute === 0 ? "noon" : hour === 0 && minute === 0 ? "midnight"
    : `${NUMBERS[hour % 12]}${minute === 0 ? "" : ` ${minuteWords(minute)}`} ${hour < 12 ? "a.m." : "p.m."}`;
  return `${p.weekday} the ${ORDINALS[Number(p.day)]} of ${p.month} at ${clock}`;
}

// Cleans an event the person edited (or the model read) into one with computed instants, spoken date and expiry.
export function normalizeEvent(raw: unknown, tz: string, now = Date.now()): { event: FlierEvent } | { error: string } {
  const zone = validTimeZone(tz) ? tz : "UTC";
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const startsAt = localToIso(r.startsAtLocal, zone) ?? (typeof r.startsAt === "string" && Number.isFinite(Date.parse(r.startsAt)) ? new Date(r.startsAt).toISOString() : undefined);
  let endsAt = localToIso(r.endsAtLocal, zone) ?? (typeof r.endsAt === "string" && Number.isFinite(Date.parse(r.endsAt)) ? new Date(r.endsAt).toISOString() : undefined);
  const base = sanitizeEvent({ ...r, startsAt, endsAt });
  if (!base) return { error: "The event needs a name" };
  let endGuessed = false;
  if (!endsAt && startsAt) { endsAt = new Date(Date.parse(startsAt) + DEFAULT_LENGTH_MS).toISOString(); endGuessed = true; }
  if (startsAt && endsAt && Date.parse(endsAt) <= Date.parse(startsAt)) return { error: "The event ends before it starts" };
  const event: FlierEvent = { ...base, tz: zone, ...(startsAt ? { startsAt } : {}), ...(endsAt ? { endsAt, expiresAt: endsAt } : {}), ...(endGuessed ? { endGuessed } : {}) };
  if (startsAt) event.whenSpoken = spokenWhen(startsAt, zone);
  if (endsAt && Date.parse(endsAt) <= now) return { error: "That event is already over, so a promo for it would never air" };
  const notes = Array.isArray(r.notes) ? r.notes.map((n) => String(n).slice(0, 160)).filter(Boolean).slice(0, 6) : [];
  if (notes.length) event.notes = notes;
  return { event };
}

// ----- writing the promo -----
export const PROMO_SYSTEM_PROMPT = (station: string, count: number, length: "short" | "medium", persona?: string) =>
  `You write radio promo spots for ${station}, read aloud by an on-air host. Use ONLY the facts you are given; never invent a price, act, address or time. ` +
  "Say the date and time in words exactly as given, with the day of the week and date: never use relative words like tonight, tomorrow or this weekend, because the spot airs for days. " +
  "Name the venue. Say any price. For a web address say only 'details on our website' unless it is very short. Spell numbers in words and avoid abbreviations and symbols. " +
  `Each spot is ${length === "short" ? "one or two sentences, about ten seconds" : "three or four sentences, about twenty seconds"}. Plain spoken words only: no stage directions, emoji or markdown. ` +
  `Write ${count} different spots and reply with ONLY a JSON array of ${count} strings.` + (persona ? ` Your character: ${persona}` : "");

export function promoFacts(event: FlierEvent): string {
  const lines = [`Event: ${event.name}`];
  if (event.whenSpoken) lines.push(`When (say it like this): ${event.whenSpoken}`);
  if (event.venue) lines.push(`Where: ${event.venue}${event.address ? `, ${event.address}` : ""}`);
  if (event.price) lines.push(`Price: ${event.price}`);
  if (event.performers?.length) lines.push(`With: ${event.performers.join(", ")}`);
  if (event.description) lines.push(`About: ${event.description}`);
  if (event.url) lines.push(`Website: ${event.url}`);
  if (event.phone) lines.push(`Phone: ${event.phone}`);
  return lines.join("\n");
}

// The model's reply as spots. Tolerates code fences, and falls back to treating a plain reply as one spot.
export function parseVariants(reply: string): string[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(reply.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) return parsed.map((v) => String(v).replace(/\s+/g, " ").trim().slice(0, 700)).filter(Boolean).slice(0, 5);
    } catch { /* fall through */ }
  }
  const plain = reply.replace(/```[a-z]*|```/g, "").replace(/\s+/g, " ").trim().slice(0, 700);
  return plain ? [plain] : [];
}
