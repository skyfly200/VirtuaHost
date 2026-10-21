// Runs the schedules that are due. Called once a minute by netlify/functions/scheduler.mts (and by "Run now" in the UI).
import { activeProvider, writeScript } from "./ai.js";
import { findFormat } from "./formats.js";
import { makeClip } from "./make-clip.js";
import { getPersona } from "./persona-store.js";
import { getStation } from "./station-profile-store.js";
import { resolveTextModel } from "./openrouter.js";
import { isExpired } from "./clip-info.js";
import { nextRun, type Schedule } from "./schedule.js";
import { listSchedules, saveSchedule } from "./schedule-store.js";
import { getClip } from "./store.js";
import { sendToStation, queueMode } from "./station-send.js";
import { createLogger } from "./log.js";
import { chargeAi } from "./quota.js";
import { findAccount } from "./session.js";
import { withKeys } from "./with-keys.js";

const log = createLogger("scheduler");

export const GRACE_MS = 10 * 60_000;       // a run later than this (the site was down) is skipped, not made late
const BUDGET_MS = 22_000;                  // a scheduled function has about 30 seconds: stop starting new work after this

// Makes the clip for one schedule and sends it as asked. Returns a short result for the UI.
// The owner's own AI key (or the station's) is used when they have one; see lib/credentials.ts.
export const runSchedule = (s: Schedule): Promise<string> => withKeys({ username: s.ownerId }, s.stationId, () => runScheduleScoped(s));

async function runScheduleScoped(s: Schedule): Promise<string> {
  // A person's schedule runs only while they can sign in, and each run spends their AI quota.
  if (s.ownerId && s.content.kind !== "clip") {
    const owner = await findAccount(s.ownerId);
    if (!owner) throw new Error("the schedule's owner no longer has an active account");
    const over = await chargeAi({ username: owner.username, role: owner.role, via: "login" });
    if (over) throw new Error(((await over.json()) as { error: string }).error);
  }
  const station = s.stationId ? await getStation(s.stationId) : null;
  const persona = s.personaId ? await getPersona(s.personaId) : station?.defaultPersonaId ? await getPersona(station.defaultPersonaId) : null;
  const stationInfo = station && station.id !== "default" ? { station: station.id } : {};
  let clipId: string;
  let audio: Buffer | undefined;
  let mimeType = "audio/mpeg";
  let title: string;

  if (s.content.kind === "clip") {
    const clip = await getClip(s.content.clipId);
    if (!clip) throw new Error("the saved clip was deleted");
    if (isExpired(clip.metadata.info)) throw new Error("the clip has expired (its event is over)");
    clipId = s.content.clipId; title = clip.metadata.scriptText; mimeType = clip.metadata.mimeType; audio = Buffer.from(clip.data);
  } else {
    let text: string;
    let mode: "say" | "ai" = "say";
    let textModel: string | undefined;
    if (s.content.kind === "ai") {
      const provider = activeProvider();
      if (!provider) throw new Error("no AI provider is configured");
      if (provider === "openrouter") textModel = (resolveTextModel(undefined, [persona?.textModel, station?.defaultTextModel]) as { model: string }).model;
      const format = s.content.format ? findFormat(s.content.format) : undefined;
      text = (await writeScript({ prompt: s.content.prompt, provider, textModel, tone: s.tone || persona?.tone, format, persona: persona?.instructions, ...(station ? { station: { name: station.name, tagline: station.tagline } } : {}) })).text;
      mode = "ai";
    } else {
      text = s.content.text;
    }
    const info = { source: "schedule", ...stationInfo, ...(s.info ?? {}), ...(s.until ? { expiresAt: s.until } : {}) };
    const made = await makeClip({ ...(s.ownerId ? { ownerId: s.ownerId } : {}), text, input: `schedule: ${s.name}`, mode, textModel, info, tone: s.tone || persona?.tone, voice: s.voice || persona?.voice || station?.defaultVoice, speechModel: s.speechModel || persona?.speechModel || station?.defaultSpeechModel });
    if (!made.ok) throw new Error(made.error);
    clipId = made.id; title = made.scriptText;
  }

  if (s.send === "none") return "saved";
  if (!queueMode()) return "saved (set STATION_MODE=queue to send schedules to the station)";
  await sendToStation({ clipId, audio: audio ?? Buffer.alloc(0), mimeType, title, play: s.send === "air", preempt: s.preempt, fx: s.fx || station?.defaultFx || undefined, ...(s.info || s.until || stationInfo.station ? { info: { ...stationInfo, ...(s.info ?? {}), ...(s.until ? { expiresAt: s.until } : {}) } } : {}) });
  return s.send === "air" ? "queued for air" : "queued for the station library";
}

// Moves a schedule on after a run (or a skipped slot).
function advance(s: Schedule, now: number, result: string): Schedule {
  const done: Schedule = { ...s, lastRunAt: new Date(now).toISOString(), lastResult: result.slice(0, 200) };
  const next = nextRun(s.when, now);
  const finished = (s.count > 0 && done.runs >= s.count) || (s.until !== undefined && next !== null && next > Date.parse(s.until));
  done.nextAt = finished || next === null ? null : new Date(next).toISOString();
  if (done.nextAt === null) done.enabled = false;
  return done;
}

export async function runDueSchedules(now = Date.now()): Promise<{ ran: number; skipped: number }> {
  let ran = 0;
  let skipped = 0;
  for (const s of await listSchedules()) {
    if (!s.enabled || !s.nextAt || Date.parse(s.nextAt) > now) continue;
    if (Date.now() - now > BUDGET_MS) break;                                   // the rest wait for the next minute
    if (s.until && Date.parse(s.until) <= now) {                                 // the event is over: never run it again
      await saveSchedule({ ...s, enabled: false, nextAt: null, lastResult: "ended: past its end date" });
      skipped += 1;
      continue;
    }
    if (now - Date.parse(s.nextAt) > GRACE_MS) {
      await saveSchedule(advance(s, now, "missed (the site was not running at that time)"));
      log.warn("schedule slot missed", { scheduleId: s.id, name: s.name, dueAt: s.nextAt });
      skipped += 1;
      continue;
    }
    let result: string;
    try {
      result = await runSchedule(s);
    } catch (err) {
      result = `error: ${(err as Error).message}`;
      log.error("schedule run failed", { scheduleId: s.id, name: s.name, err });
    }
    await saveSchedule(advance({ ...s, runs: s.runs + 1 }, now, result));
    ran += 1;
  }
  return { ran, skipped };
}
