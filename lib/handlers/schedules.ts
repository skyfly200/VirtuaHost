import { checkAuth } from "../auth.js";
import { applySchedulePatch, buildSchedule, MAX_SCHEDULES } from "../schedule.js";
import { deleteSchedule, getSchedule, listSchedules, saveSchedule } from "../schedule-store.js";
import { runSchedule } from "../scheduler.js";
import { getClip } from "../store.js";

// GET /api/schedules; POST /api/schedules (create); PUT /api/schedules/:id (name, enabled, send, preempt);
// DELETE /api/schedules/:id; POST /api/schedules/:id/run (run it now, without moving its timetable).
export async function handleSchedules(req: Request, id: string | undefined, action: string | undefined): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;
  const json = async () => { try { return await req.json(); } catch { return undefined; } };

  if (!id) {
    if (req.method === "GET") return Response.json({ schedules: await listSchedules() });
    if (req.method === "POST") {
      if ((await listSchedules()).length >= MAX_SCHEDULES) return Response.json({ error: `At most ${MAX_SCHEDULES} schedules` }, { status: 400 });
      try {
        const schedule = buildSchedule(await json());
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
  if (!existing) return Response.json({ error: "Schedule not found" }, { status: 404 });

  if (action === "run" && req.method === "POST") {
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
