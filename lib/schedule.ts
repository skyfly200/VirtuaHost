// Schedules: clips that are made and sent to the station on a timetable. Pure rules here (validation, "when is the next
// one"); storage is lib/schedule-store.ts and the runner is lib/scheduler.ts, called every minute by a Netlify scheduled function.
import { randomBytes } from "node:crypto";
import { sanitizeInfo, type ClipInfo } from "./clip-info.js";

export type When =
  | { type: "once"; at: string }
  | { type: "interval"; everyMinutes: number; startAt?: string }
  | { type: "daily"; time: string; days: number[]; tz: string };

export type Content =
  | { kind: "text"; text: string }
  | { kind: "ai"; prompt: string; format?: string }
  | { kind: "clip"; clipId: string };

export interface Schedule {
  id: string;
  name: string;
  enabled: boolean;
  when: When;
  content: Content;
  personaId: string;
  /** Overrides on top of the persona's delivery. */
  voice: string;
  speechModel: string;
  tone: string;
  /** "air": queue it to go on air; "library": queue it for the station to keep; "none": only save the clip. */
  send: "air" | "library" | "none";
  preempt: boolean;
  fx: string;
  /** Stop after this many runs (0 = no limit). */
  count: number;
  /** Never run after this instant (ISO 8601): an event promo stops when the event is over. Also the expiry of the clips it makes. */
  until?: string;
  /** Metadata for the clips it makes (kind, event, ...). */
  info?: ClipInfo;
  runs: number;
  nextAt: string | null;
  lastRunAt?: string;
  lastResult?: string;
  createdAt: string;
}

export const MAX_SCHEDULES = 100;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

// ----- time zones, without a library -----
const parts = (ms: number, tz: string) => {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const get = Object.fromEntries(f.formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { year: Number(get.year), month: Number(get.month), day: Number(get.day), hour: Number(get.hour), minute: Number(get.minute), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get.weekday) };
};

export const validTimeZone = (tz: string): boolean => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); return true; } catch { return false; }
};

// The UTC instant at which the clock in `tz` reads y-m-d h:m (the first one when a DST change makes it ambiguous or missing).
function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let result = guess;
  for (let i = 0; i < 2; i++) {
    const p = parts(result, tz);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    result += guess - shown;
  }
  return result;
}

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

// The first time this schedule is due strictly after `after` (ms), or null when it never runs again.
export function nextRun(when: When, after: number): number | null {
  if (when.type === "once") {
    const at = Date.parse(when.at);
    return Number.isFinite(at) && at > after ? at : null;
  }
  if (when.type === "interval") {
    const step = when.everyMinutes * 60_000;
    const start = when.startAt ? Date.parse(when.startAt) : after;
    if (!Number.isFinite(start)) return null;
    return start > after ? start : start + step * (Math.floor((after - start) / step) + 1);
  }
  const m = TIME.exec(when.time);
  if (!m) return null;
  const today = parts(after, when.tz);
  for (let offset = 0; offset <= 8; offset++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const instant = zonedToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), Number(m[1]), Number(m[2]), when.tz);
    if (instant <= after) continue;
    const weekday = parts(instant, when.tz).weekday;
    if (when.days.length === 0 || when.days.includes(weekday)) return instant;
  }
  return null;
}

// ----- validation -----
export function sanitizeWhen(raw: unknown, now = Date.now()): When {
  const w = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (w.type === "once") {
    const at = Date.parse(String(w.at));
    if (!Number.isFinite(at)) throw new Error("Pick the date and time to run");
    return { type: "once", at: new Date(at).toISOString() };
  }
  if (w.type === "interval") {
    const every = Math.floor(Number(w.everyMinutes));
    if (!Number.isFinite(every) || every < 5 || every > 60 * 24 * 7) throw new Error("Repeat every 5 minutes to 7 days");
    const start = w.startAt ? Date.parse(String(w.startAt)) : now;
    if (!Number.isFinite(start)) throw new Error("startAt must be a date and time");
    return { type: "interval", everyMinutes: every, startAt: new Date(start).toISOString() };
  }
  if (w.type === "daily") {
    const time = str(w.time, 5);
    if (!TIME.test(time)) throw new Error("Time must look like 07:30");
    const tz = str(w.tz, 60) || "UTC";
    if (!validTimeZone(tz)) throw new Error(`Unknown time zone "${tz}"`);
    const days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : [];
    return { type: "daily", time, days, tz };
  }
  throw new Error('"when" must be once, interval or daily');
}

export function sanitizeContent(raw: unknown): Content {
  const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  if (c.kind === "text") {
    const text = str(c.text, 2000);
    if (!text) throw new Error("Enter the text to say");
    return { kind: "text", text };
  }
  if (c.kind === "ai") {
    const prompt = str(c.prompt, 2000);
    if (!prompt) throw new Error("Enter a brief for the AI");
    const format = str(c.format, 40);
    return { kind: "ai", prompt, ...(format ? { format } : {}) };
  }
  if (c.kind === "clip") {
    const clipId = str(c.clipId, 64);
    if (!/^[A-Za-z0-9-]{1,64}$/.test(clipId)) throw new Error("Pick a saved clip");
    return { kind: "clip", clipId };
  }
  throw new Error('"content" must be text, ai or clip');
}

export function buildSchedule(raw: unknown, now = Date.now()): Schedule {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const when = sanitizeWhen(r.when, now);
  const content = sanitizeContent(r.content);
  const untilMs = r.until ? Date.parse(String(r.until)) : NaN;
  if (r.until && !Number.isFinite(untilMs)) throw new Error("until must be a date and time");
  const first = nextRun(when, now - 1);   // a time right now still counts
  if (first === null) throw new Error("That time has already passed");
  if (Number.isFinite(untilMs) && first > untilMs) throw new Error("The first run would be after the end date");
  const label = content.kind === "text" ? content.text : content.kind === "ai" ? content.prompt : "saved clip";
  return {
    id: randomBytes(6).toString("hex"),
    name: str(r.name, 80) || label.slice(0, 60),
    enabled: true, when, content,
    personaId: str(r.personaId, 60), voice: str(r.voice, 60), speechModel: str(r.speechModel, 100), tone: str(r.tone, 100),
    send: r.send === "air" || r.send === "library" ? r.send : "none",
    preempt: r.preempt === true, fx: str(r.fx, 40),
    count: clamp(Math.floor(Number(r.count)) || 0, 0, 10000), runs: 0,
    ...(Number.isFinite(untilMs) ? { until: new Date(untilMs).toISOString() } : {}),
    ...(r.info ? { info: sanitizeInfo(r.info) } : {}),
    nextAt: new Date(first).toISOString(), createdAt: new Date(now).toISOString(),
  };
}

// What the Schedules UI may change on an existing schedule.
export function applySchedulePatch(s: Schedule, patch: unknown, now = Date.now()): Schedule {
  const p = (patch && typeof patch === "object" ? patch : {}) as Record<string, unknown>;
  const next = { ...s };
  if (typeof p.name === "string" && p.name.trim()) next.name = p.name.trim().slice(0, 80);
  if (typeof p.preempt === "boolean") next.preempt = p.preempt;
  if (p.send === "air" || p.send === "library" || p.send === "none") next.send = p.send;
  if (typeof p.enabled === "boolean") {
    next.enabled = p.enabled;
    // Switching one back on starts from the next slot, never from the past.
    if (next.enabled) { const n = nextRun(next.when, now); next.nextAt = n === null ? null : new Date(n).toISOString(); }
  }
  return next;
}
