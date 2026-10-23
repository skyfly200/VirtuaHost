import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { offsetMinutes, zoneWarnings } from "../../lib/timezones.js";

const agentTz = createRequire(import.meta.url)("../../chips-voice/agent-radiodj/tz.js") as typeof import("../../lib/timezones.js");

describe("timezones (site twin of the agent's tz.js)", () => {
  const at = Date.parse("2026-10-22T20:00:00Z");
  it("Central machine / Denver broadcast: warns that the clocks differ by an hour", () => {
    const w = zoneWarnings({ machineTz: "America/Chicago", broadcastTz: "America/Denver", pcOffsetMinutes: -300, now: at });
    expect(w.map((x) => x.code)).toEqual(["zones-differ"]);
    expect(w[0].message).toContain("1 hour");
  });
  it("warns when the PC's real offset does not match the declared machineTz", () => {
    expect(zoneWarnings({ machineTz: "America/Denver", broadcastTz: "America/Denver", pcOffsetMinutes: -300, now: at }).map((x) => x.code)).toEqual(["pc-offset-mismatch"]);
    expect(zoneWarnings({ machineTz: "America/Denver", broadcastTz: "America/Denver", pcOffsetMinutes: -360, now: at })).toEqual([]);
  });
  it("handles DST edges (2026-03-08 spring forward, 2026-11-01 fall back) and agrees with the agent's copy", () => {
    for (const iso of ["2026-03-08T08:59:00Z", "2026-03-08T09:00:00Z", "2026-11-01T06:59:00Z", "2026-11-01T07:00:00Z", "2026-12-31T23:59:00Z"]) {
      for (const tz of ["America/Denver", "America/Chicago", "UTC", "Asia/Kolkata"]) {
        expect(offsetMinutes(Date.parse(iso), tz)).toBe((agentTz as unknown as { offsetMinutes: typeof offsetMinutes }).offsetMinutes(Date.parse(iso), tz));
      }
    }
    expect(offsetMinutes(Date.parse("2026-03-08T08:59:00Z"), "America/Denver")).toBe(-420);
    expect(offsetMinutes(Date.parse("2026-03-08T09:00:00Z"), "America/Denver")).toBe(-360);
  });
  it("flags missing and invalid zones", () => {
    expect(zoneWarnings({ now: at }).map((x) => x.code)).toEqual(["machine-tz-missing", "broadcast-tz-missing"]);
    expect(zoneWarnings({ machineTz: "Nope", broadcastTz: "Nope2", now: at }).map((x) => x.code)).toEqual(["machine-tz-invalid", "broadcast-tz-invalid"]);
  });
});
