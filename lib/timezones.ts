// Two time zones, never conflated:
//   broadcastTz  the station's wall clock: {{time}}, schedules, "tonight at 7", weather and alert wording.
//   machineTz    the clock of the PC running the playout software (may differ, e.g. Central PC for a Denver station): used ONLY to read
//                timestamps that come from that PC.
// This is the site's typed twin of chips-voice/agent-radiodj/tz.js (the agent and hub use that one); test/lib/timezones.test.ts checks they agree.
import { validTimeZone } from "./schedule.js";

export type ZoneWarning = { code: string; level: "warn" | "error"; message: string };

const pad = (n: number) => String(n).padStart(2, "0");
export const formatOffset = (min: number): string => `UTC${min < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(min) / 60))}:${pad(Math.abs(min) % 60)}`;

/** The zone's offset from UTC at an instant, in minutes (Denver in July: -360). */
export function offsetMinutes(ms: number, tz: string): number {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Math.round((Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000);
}

/** What to tell a person about the two clocks. `pcOffsetMinutes` is what the PC itself reports; if it disagrees with machineTz, one of them is wrong. */
export function zoneWarnings(o: { machineTz?: string; broadcastTz?: string; pcOffsetMinutes?: number; now?: number }): ZoneWarning[] {
  const now = o.now ?? Date.now();
  const out: ZoneWarning[] = [];
  const machineOk = !!o.machineTz && validTimeZone(o.machineTz);
  const broadcastOk = !!o.broadcastTz && validTimeZone(o.broadcastTz);
  if (!o.machineTz) out.push({ code: "machine-tz-missing", level: "warn", message: "machineTz is not set. Set the time zone of the RadioDJ PC so its timestamps are read correctly." });
  else if (!machineOk) out.push({ code: "machine-tz-invalid", level: "error", message: `machineTz "${o.machineTz}" is not a time zone name (use something like America/Chicago).` });
  if (!o.broadcastTz) out.push({ code: "broadcast-tz-missing", level: "warn", message: "broadcastTz is not set. Set the station's own time zone (for example America/Denver)." });
  else if (!broadcastOk) out.push({ code: "broadcast-tz-invalid", level: "error", message: `broadcastTz "${o.broadcastTz}" is not a time zone name (use something like America/Denver).` });
  if (machineOk && broadcastOk) {
    const a = offsetMinutes(now, o.machineTz!); const b = offsetMinutes(now, o.broadcastTz!);
    if (a !== b) {
      const diff = Math.abs(b - a) / 60;
      out.push({ code: "zones-differ", level: "warn", message: `The PC clock (${o.machineTz}) and the broadcast clock (${o.broadcastTz}) differ by ${diff} hour${diff === 1 ? "" : "s"} right now. Times from the PC are converted; on-air wording uses ${o.broadcastTz}.` });
    }
  }
  if (machineOk && typeof o.pcOffsetMinutes === "number" && Number.isFinite(o.pcOffsetMinutes)) {
    const declared = offsetMinutes(now, o.machineTz!);
    if (declared !== o.pcOffsetMinutes) {
      out.push({ code: "pc-offset-mismatch", level: "error", message: `The PC reports a UTC offset of ${formatOffset(o.pcOffsetMinutes)} but machineTz ${o.machineTz} is ${formatOffset(declared)} right now. Fix machineTz or the PC's time zone setting.` });
    }
  }
  return out;
}
