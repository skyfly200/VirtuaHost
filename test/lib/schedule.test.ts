import { describe, it, expect, vi, beforeEach } from "vitest";

const blobs = new Map<string, unknown>();
vi.mock("@netlify/blobs", () => ({
  getStore: () => ({
    list: async ({ prefix }: { prefix: string }) => ({ blobs: [...blobs.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    get: async (key: string) => blobs.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => { blobs.set(key, JSON.parse(JSON.stringify(value))); },
    delete: async (key: string) => { blobs.delete(key); },
  }),
}));
vi.mock("../../lib/make-clip.js", () => ({ makeClip: vi.fn() }));
vi.mock("../../lib/station-send.js", () => ({ sendToStation: vi.fn(async () => ({ sent: true, queued: true })), queueMode: vi.fn(() => true) }));
vi.mock("../../lib/store.js", () => ({ getClip: vi.fn(async () => null), saveClip: vi.fn(), listClips: vi.fn() }));

import { makeClip } from "../../lib/make-clip.js";
import { sendToStation } from "../../lib/station-send.js";
import { buildSchedule, nextRun, sanitizeWhen } from "../../lib/schedule.js";
import { listSchedules, saveSchedule } from "../../lib/schedule-store.js";
import { runDueSchedules, GRACE_MS } from "../../lib/scheduler.js";

const at = (iso: string) => Date.parse(iso);

describe("nextRun", () => {
  it("handles once and intervals", () => {
    expect(nextRun({ type: "once", at: "2030-01-01T10:00:00Z" }, at("2030-01-01T09:00:00Z"))).toBe(at("2030-01-01T10:00:00Z"));
    expect(nextRun({ type: "once", at: "2030-01-01T10:00:00Z" }, at("2030-01-01T10:00:00Z"))).toBeNull();
    const w = { type: "interval", everyMinutes: 30, startAt: "2030-01-01T10:00:00Z" } as const;
    expect(nextRun(w, at("2030-01-01T09:00:00Z"))).toBe(at("2030-01-01T10:00:00Z"));
    expect(nextRun(w, at("2030-01-01T10:00:00Z"))).toBe(at("2030-01-01T10:30:00Z"));
    expect(nextRun(w, at("2030-01-01T12:10:00Z"))).toBe(at("2030-01-01T12:30:00Z"));   // skips missed slots
  });

  it("runs daily at a local time, across a daylight-saving change", () => {
    const w = { type: "daily", time: "07:30", days: [], tz: "America/New_York" } as const;
    expect(nextRun(w, at("2030-03-09T00:00:00Z"))).toBe(at("2030-03-09T12:30:00Z"));   // EST (UTC-5)
    expect(nextRun(w, at("2030-03-09T13:00:00Z"))).toBe(at("2030-03-10T11:30:00Z"));   // clocks changed on the 10th: now EDT (UTC-4)
    expect(nextRun({ ...w, tz: "Asia/Tokyo" }, at("2030-03-09T00:00:00Z"))).toBe(at("2030-03-08T22:30:00Z") + 24 * 3600_000);
  });

  it("limits daily runs to chosen weekdays", () => {
    // 2030-01-07 is a Monday; ask for Wednesday (3) and Friday (5) at 09:00 UTC
    const w = { type: "daily", time: "09:00", days: [3, 5], tz: "UTC" } as const;
    expect(nextRun(w, at("2030-01-07T00:00:00Z"))).toBe(at("2030-01-09T09:00:00Z"));
    expect(nextRun(w, at("2030-01-09T09:00:00Z"))).toBe(at("2030-01-11T09:00:00Z"));
  });

  it("rejects bad input", () => {
    expect(() => sanitizeWhen({ type: "daily", time: "7:30", tz: "UTC" })).toThrow(/Time must/);
    expect(() => sanitizeWhen({ type: "daily", time: "07:30", tz: "Mars/Base" })).toThrow(/time zone/);
    expect(() => sanitizeWhen({ type: "interval", everyMinutes: 1 })).toThrow(/5 minutes/);
    expect(() => buildSchedule({ when: { type: "once", at: "2001-01-01T00:00:00Z" }, content: { kind: "text", text: "x" } })).toThrow(/already passed/);
  });
});

describe("running schedules", () => {
  beforeEach(() => {
    blobs.clear();
    vi.clearAllMocks();
    vi.mocked(makeClip).mockResolvedValue({ ok: true, id: "clip9", scriptText: "Good morning", mimeType: "audio/mpeg", speechModel: "m", voice: "v" });
  });
  const make = (extra: object = {}, now = at("2030-01-01T06:00:00Z")) =>
    buildSchedule({ name: "Morning", when: { type: "daily", time: "07:00", days: [], tz: "UTC" }, content: { kind: "text", text: "Good morning" }, send: "air", ...extra }, now);

  it("makes, sends and moves a due schedule on to its next slot", async () => {
    const s = make();
    await saveSchedule(s);
    expect(await runDueSchedules(at("2030-01-01T06:30:00Z"))).toEqual({ ran: 0, skipped: 0 });   // not due yet
    expect(await runDueSchedules(at("2030-01-01T07:00:30Z"))).toEqual({ ran: 1, skipped: 0 });
    expect(vi.mocked(sendToStation).mock.calls[0][0]).toMatchObject({ clipId: "clip9", play: true, title: "Good morning" });
    const [after] = await listSchedules();
    expect(after).toMatchObject({ runs: 1, lastResult: "queued for air", nextAt: "2030-01-02T07:00:00.000Z", enabled: true });
  });

  it("skips a slot the site slept through, and stops after its run count", async () => {
    await saveSchedule(make());
    expect(await runDueSchedules(at("2030-01-01T07:00:00Z") + GRACE_MS + 60_000)).toEqual({ ran: 0, skipped: 1 });
    expect(makeClip).not.toHaveBeenCalled();
    expect((await listSchedules())[0].lastResult).toMatch(/missed/);

    blobs.clear();
    await saveSchedule(make({ count: 1 }));
    await runDueSchedules(at("2030-01-01T07:00:10Z"));
    expect((await listSchedules())[0]).toMatchObject({ enabled: false, nextAt: null, runs: 1 });
  });

  it("records an error and keeps the timetable when making the clip fails", async () => {
    vi.mocked(makeClip).mockResolvedValue({ ok: false, status: 502, error: "Speech synthesis failed: down" });
    await saveSchedule(make());
    await runDueSchedules(at("2030-01-01T07:00:10Z"));
    expect((await listSchedules())[0]).toMatchObject({ lastResult: "error: Speech synthesis failed: down", nextAt: "2030-01-02T07:00:00.000Z" });
  });
});
