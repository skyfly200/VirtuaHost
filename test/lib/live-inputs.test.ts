import { describe, expect, it } from "vitest";
import { assessRisk, evalCondition, liveHelp, sanitizeGate, type Live, type Sample } from "../../lib/live-inputs.js";
import { sanitizeContext, stationBrief } from "../../lib/station-context.js";
import { buildSystemPrompt } from "../../lib/formats.js";
import { buildSchedule, applySchedulePatch } from "../../lib/schedule.js";

const s = (o: Partial<Sample>): Sample => ({ tempC: 5, precipMm: 0, snowCm: 0, code: 0, ...o });
const live = (o: Partial<Live> = {}): Live => ({ at: 0, weather: s({}), alerts: [], roads: [], ...o });

describe("road risk", () => {
  it("is none when dry and warm", () => expect(assessRisk(s({})).risk).toBe("none"));
  it("is high with precipitation at freezing", () => expect(assessRisk(s({ tempC: -1, precipMm: 0.4 })).risk).toBe("high"));
  it("is watch near freezing and wet", () => expect(assessRisk(s({ tempC: 2, code: 61 })).risk).toBe("watch"));
  it("looks at the next hours too", () => expect(assessRisk(s({ tempC: 3, nextHoursMinC: -1, nextHoursPrecipMm: 1 })).risk).toBe("high"));
  it("is high for freezing rain", () => expect(assessRisk(s({ tempC: 1, code: 66 })).risk).toBe("high"));
  it("is none without data", () => expect(assessRisk(null).risk).toBe("none"));
});

describe("conditions", () => {
  const roads = [{ road: "Left Hand Canyon Drive", risk: "high" as const, why: "snow", sample: null }, { road: "Peak to Peak Highway", risk: "none" as const, why: "", sample: null }];
  it("matches a named road at the threshold", () => {
    expect(evalCondition({ kind: "road-risk", road: "left hand canyon drive", min: "watch" }, live({ roads })).met).toBe(true);
    expect(evalCondition({ kind: "road-risk", road: "Peak to Peak Highway", min: "watch" }, live({ roads })).met).toBe(false);
    expect(evalCondition({ kind: "road-risk", road: "Nope", min: "watch" }, live({ roads })).met).toBe(false);
  });
  it("matches alerts by type and severity", () => {
    const alerts = [{ id: "1", event: "Winter Storm Warning", severity: "Severe" as const, headline: "", area: "Boulder", instruction: "", expires: null, sent: null }];
    expect(evalCondition({ kind: "alert", events: ["winter storm"], minSeverity: "Moderate" }, live({ alerts })).met).toBe(true);
    expect(evalCondition({ kind: "alert", events: ["flood"] }, live({ alerts })).met).toBe(false);
    expect(evalCondition({ kind: "alert" }, live()).met).toBe(false);
  });
  it("fails closed without weather", () => {
    expect(evalCondition({ kind: "temp", op: "below", value: 40 }, live({ weather: null })).met).toBe(false);
    expect(evalCondition({ kind: "precip" }, live({ weather: null })).met).toBe(false);
  });
  it("compares temperature in the station's unit", () => {
    expect(evalCondition({ kind: "temp", op: "below", value: 32 }, live({ weather: s({ tempC: -1 }) }), "F").met).toBe(true);
    expect(evalCondition({ kind: "temp", op: "below", value: 0 }, live({ weather: s({ tempC: 5 }) }), "C").met).toBe(false);
  });
});

describe("gate", () => {
  it("defaults to a dry run with a cooldown", () => {
    const g = sanitizeGate({ condition: { kind: "road-risk", min: "watch" } })!;
    expect(g.dryRun).toBe(true);
    expect(g.cooldownMinutes).toBe(180);
  });
  it("goes live only on purpose", () => expect(sanitizeGate({ dryRun: false, condition: { kind: "precip" } })!.dryRun).toBe(false));
  it("rejects an unknown condition", () => expect(() => sanitizeGate({ condition: { kind: "nope" } })).toThrow());
  it("is kept on a schedule and removable", () => {
    const sch = buildSchedule({ when: { type: "interval", everyMinutes: 10 }, content: { kind: "text", text: "Ice on the canyon." }, gate: { condition: { kind: "road-risk", min: "high" } } });
    expect(sch.gate?.condition).toEqual({ kind: "road-risk", min: "high" });
    expect(applySchedulePatch(sch, { gate: null }).gate).toBeUndefined();
  });
});

describe("station context", () => {
  const ctx = sanitizeContext({ about: "In the foothills.", roads: [{ name: "Left Hand Canyon Drive", aliases: "the canyon, Left Hand Canyon", lat: "40.1", lon: "-105.38" }, { name: "" }] })!;
  it("cleans roads", () => {
    expect(ctx.roads).toHaveLength(1);
    expect(ctx.roads[0]).toMatchObject({ aliases: ["the canyon", "Left Hand Canyon"], lat: 40.1, lon: -105.38 });
  });
  it("is empty when nothing was entered", () => expect(sanitizeContext({ about: "", roads: [] })).toBeUndefined());
  it("lands in the system prompt and tells the writer what 'the roads' means", () => {
    const brief = stationBrief({ context: ctx, city: "Ward" });
    expect(brief).toContain("Left Hand Canyon Drive");
    expect(buildSystemPrompt({ station: "Way High Radio", brief })).toContain("the canyon");
  });
});

describe("live help", () => {
  it("states only known facts and flags road risk as an estimate", () => {
    const text = liveHelp(live({ roads: [{ road: "Left Hand Canyon Drive", risk: "high", why: "snow falling", sample: null }] }));
    expect(text).toContain("not a road sensor");
    expect(text).toContain("Left Hand Canyon Drive high");
  });
  it("is empty with nothing known", () => expect(liveHelp(live({ weather: null }))).toBe(""));
});
