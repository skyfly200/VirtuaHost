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

vi.mock("../../lib/live-inputs.js", async (orig) => ({ ...(await orig<typeof import("../../lib/live-inputs.js")>()), liveFor: vi.fn(async () => ({ at: 0, weather: { tempC: -2, precipMm: 1, snowCm: 0, code: 61 }, alerts: [], roads: [{ road: "Left Hand Canyon Drive", risk: mockRisk.value, why: "wet and freezing", sample: null }] })) }));
const mockRisk = vi.hoisted(() => ({ value: "high" as "none" | "high" }));

import { makeClip } from "../../lib/make-clip.js";
import { buildSchedule } from "../../lib/schedule.js";
import { listSchedules, saveSchedule } from "../../lib/schedule-store.js";
import { runDueSchedules } from "../../lib/scheduler.js";

const base = Date.parse("2030-01-01T10:00:00Z");
const make = (dryRun: boolean, extra = {}) => ({ ...buildSchedule({ when: { type: "interval", everyMinutes: 10, startAt: "2030-01-01T10:00:00Z" }, content: { kind: "text", text: "Ice on the canyon." }, gate: { condition: { kind: "road-risk", min: "high" }, dryRun, cooldownMinutes: 60 } }, base - 1000), ...extra });

beforeEach(() => { blobs.clear(); vi.clearAllMocks(); mockRisk.value = "high"; (makeClip as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, id: "c1", scriptText: "x", mimeType: "audio/wav" }); });

describe("conditional schedules", () => {
  it("a dry run notes what it would do and makes nothing", async () => {
    await saveSchedule(make(true));
    await runDueSchedules(base);
    expect(makeClip).not.toHaveBeenCalled();
    const [s] = await listSchedules();
    expect(s.lastResult).toMatch(/dry run: would have run/);
    expect(s.runs).toBe(0);
  });
  it("runs when live and the condition holds, then respects the cooldown", async () => {
    await saveSchedule(make(false));
    await runDueSchedules(base);
    expect(makeClip).toHaveBeenCalledTimes(1);
    await runDueSchedules(base + 10 * 60_000);
    expect(makeClip).toHaveBeenCalledTimes(1);
    expect((await listSchedules())[0].lastResult).toMatch(/cooldown/);
    for (let m = 20; m <= 70; m += 10) await runDueSchedules(base + m * 60_000);
    expect(makeClip).toHaveBeenCalledTimes(2);
  });
  it("does nothing, and counts no run, when the condition is not met", async () => {
    mockRisk.value = "none";
    await saveSchedule(make(false));
    await runDueSchedules(base);
    expect(makeClip).not.toHaveBeenCalled();
    const [s] = await listSchedules();
    expect(s.runs).toBe(0);
    expect(s.nextAt).not.toBeNull();
  });
});
