import { authorize, canModify, canView, ownerFor } from "../auth.js";
import { chargeAi, checkCount } from "../quota.js";
import { applySchedulePatch, buildSchedule, MAX_SCHEDULES } from "../schedule.js";
import { deleteSchedule, getSchedule, listSchedules, saveSchedule } from "../schedule-store.js";
import { runSchedule } from "../scheduler.js";
import { getClip } from "../store.js";

// GET /api/schedules; POST /api/schedules (create); PUT /api/schedules/:id (name, enabled, send, preempt);
// DELETE /api/schedules/:id; POST /api/schedules/:id/run (run it now, without moving its timetable).
export async function handleSchedules(req: Request, id: string | undefined, action: string | undefined): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;
  const json = async () => { try { return await req.json(); } catch { return undefined; } };

  if (!id) {
    if (req.method === "GET") return Response.json({ schedules: (await listSchedules()).filter((s) => canView(who, s.ownerId)) });
    if (req.method === "POST") {
      const full = await checkCount(who, "maxSchedules", async () => (await listSchedules()).filter((s) => s.ownerId === who.username).length);
      if (full) return full;
      if ((await listSchedules()).length >= MAX_SCHEDULES) return Response.json({ error: `At most ${MAX_SCHEDULES} schedules` }, { status: 400 });
      try {
        const schedule = { ...buildSchedule(await json()), ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}) };
        if (schedule.content.kind === "clip" && !(await getClip(schedule.content.clipId))) return Response.json({ error: "Clip not found" }, { status: 404 });
        await saveSchedule(schedule);
        return Response.json({ schedule }, { status: 201 });
      } catch (err) {
        return Response.json({ error: (err as Error).message }, { status: 400 });
      }
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  const existing = await getSchedule(id);
  if (!existing || !canView(who, existing.ownerId)) return Response.json({ error: "Schedule not found" }, { status: 404 });
  if (!canModify(who, existing.ownerId)) return Response.json({ error: "That schedule is shared; only an admin can change it" }, { status: 403 });

  if (action === "run" && req.method === "POST") {
    const over = existing.content.kind === "clip" ? null : await chargeAi(who);
    if (over) return over;
    try {
      const result = await runSchedule(existing);
      await saveSchedule({ ...existing, lastRunAt: new Date().toISOString(), lastResult: `${result} (run by hand)` });
      return Response.json({ result });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 502 });
    }
  }
  if (!action && req.method === "PUT") {
    const schedule = applySchedulePatch(existing, await json());
    await saveSchedule(schedule);
    return Response.json({ schedule });
  }
  if (!action && req.method === "DELETE") {
    await deleteSchedule(id);
    return new Response(null, { status: 204 });
  }
  return new Response("Method Not Allowed", { status: 405 });
}
