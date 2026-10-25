import { authorize, canModify, canView, ownerFor, type Principal } from "../auth.js";
import { chargeAi } from "../quota.js";
import { withKeys } from "../with-keys.js";
import { activeProvider, NO_PROVIDER_MESSAGE } from "../ai.js";
import { resolveTextModel } from "../openrouter.js";
import { contextFor, renderTemplate } from "../drop-template.js";
import { getPersona } from "../persona-store.js";
import { getStation } from "../station-profile-store.js";
import { deleteScript, getScript, listScripts, newScriptId, saveScript, SCRIPT_ID } from "../script-store.js";
import { DraftFormatError, draftScript } from "../script-draft.js";
import { effectNames, sfxHelp } from "../sfx-mix.js";
import { sanitizeCast, sanitizeScript, type Script } from "../scripts.js";
import type { Persona } from "../personas.js";

const readJson = async (req: Request): Promise<Record<string, unknown> | undefined> => {
  try { return (await req.json()) as Record<string, unknown>; } catch { return undefined; }
};

// GET|POST /api/scripts, GET|PUT|DELETE /api/scripts/:id,
// POST /api/scripts/draft (the AI drafts a script from its cast; nothing is saved), POST /api/scripts/filled (a saved script with placeholders filled in, for a given moment).
export async function handleScripts(req: Request, id: string | undefined): Promise<Response> {
  const special = id === "draft" || id === "filled";
  const { who, denied } = await authorize(req, { scope: id === "draft" ? "generate" : req.method === "GET" || id === "filled" ? "scripts.read" : undefined });
  if (denied) return denied;

  if (id === "draft") return req.method === "POST" ? draft(req, who) : new Response("Method Not Allowed", { status: 405 });
  if (id === "filled") return req.method === "POST" ? filled(req, who) : new Response("Method Not Allowed", { status: 405 });

  if (!id) {
    if (req.method === "GET") return Response.json({ scripts: (await listScripts()).filter((s) => canView(who, s.ownerId)) });
    if (req.method === "POST") {
      const clean = sanitizeScript(await readJson(req));
      if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
      const script = await saveScript({ id: newScriptId(clean.script.name), ...clean.script, ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}) });
      return Response.json({ script }, { status: 201 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }
  if (special || !SCRIPT_ID.test(id)) return Response.json({ error: "Script not found" }, { status: 404 });
  const existing = await getScript(id);
  if (!existing || !canView(who, existing.ownerId)) return Response.json({ error: "Script not found" }, { status: 404 });
  if (req.method === "GET") return Response.json({ script: existing });
  if (!canModify(who, existing.ownerId)) return Response.json({ error: "That script is shared; duplicate it to make your own" }, { status: 403 });
  if (req.method === "PUT") {
    const clean = sanitizeScript(await readJson(req));
    if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
    const script = await saveScript({ id, ...clean.script, ...(existing.ownerId ? { ownerId: existing.ownerId } : {}), createdAt: existing.createdAt });
    return Response.json({ script });
  }
  if (req.method === "DELETE") { await deleteScript(id); return new Response(null, { status: 204 }); }
  return new Response("Method Not Allowed", { status: 405 });
}

const atOf = (v: unknown): Date | undefined => {
  const ms = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) && ms - Date.now() <= 3 * 3600e3 && ms - Date.now() >= -5 * 60e3 ? new Date(ms) : undefined;
};
const stringList = (v: unknown, n: number, max: number): string[] => (Array.isArray(v) ? v.map((x) => String(x).trim().slice(0, max)).filter(Boolean).slice(0, n) : []);

async function personasFor(cast: Array<{ personaId?: string }>, who: Principal): Promise<{ map: Map<string, Persona> } | { error: string }> {
  const map = new Map<string, Persona>();
  for (const c of cast) {
    if (!c.personaId || map.has(c.personaId)) continue;
    const p = await getPersona(c.personaId);
    if (!p || !canView(who, p.ownerId)) return { error: `Unknown persona "${c.personaId.slice(0, 50)}"` };
    map.set(c.personaId, p);
  }
  return { map };
}

async function draft(req: Request, who: Principal): Promise<Response> {
  const body = await readJson(req);
  if (!body) return Response.json({ error: "Request body must be JSON" }, { status: 400 });
  let saved: Script | null = null;
  if (typeof body.scriptId === "string") {
    saved = await getScript(body.scriptId);
    if (!saved || !canView(who, saved.ownerId)) return Response.json({ error: "Script not found" }, { status: 404 });
  }
  const kind = (saved?.kind ?? body.kind) === "conversation" ? "conversation" : "single";
  const castResult = sanitizeCast(saved?.cast ?? body.cast);
  if ("error" in castResult) return Response.json({ error: castResult.error }, { status: 400 });
  const cast = castResult.cast;
  if (kind === "conversation" && cast.length < 2) return Response.json({ error: "A conversation needs at least two speakers" }, { status: 400 });
  if (!cast.length) return Response.json({ error: "Choose who speaks first (the cast)" }, { status: 400 });
  const topic = String(body.topic ?? saved?.topic ?? "").trim().slice(0, 600);
  if (!topic) return Response.json({ error: "Say what the script should be about (topic)" }, { status: 400 });
  const provider = activeProvider();
  if (!provider) return Response.json({ error: NO_PROVIDER_MESSAGE }, { status: 503 });
  const stationId = typeof body.station === "string" ? body.station : saved?.stationId;
  return withKeys(who, stationId, async () => {
    const over = await chargeAi(who);
    if (over) return over;
    const station = stationId ? await getStation(stationId) : null;
    if (stationId && !station) return Response.json({ error: `Unknown station "${stationId.slice(0, 50)}"` }, { status: 400 });
    const personas = await personasFor(cast, who);
    if ("error" in personas) return Response.json({ error: personas.error }, { status: 400 });
    let textModel: string | undefined;
    if (provider === "openrouter") {
      const first = cast.map((c) => (c.personaId ? personas.map.get(c.personaId)?.textModel : undefined)).find(Boolean);
      const t = resolveTextModel(typeof body.textModel === "string" ? body.textModel : undefined, [first, station?.defaultTextModel]);
      if ("error" in t) return Response.json({ error: t.error }, { status: 400 });
      textModel = t.model;
    }
    const seconds = Number(body.seconds ?? saved?.seconds);
    const template = contextFor({ station, now: atOf(body.at), targetSeconds: Number.isFinite(seconds) && seconds >= 3 ? Math.round(seconds) : undefined });
    try {
      const out = await draftScript({ kind, cast, topic, format: String(body.format ?? saved?.format ?? "") || undefined, seconds: Number.isFinite(seconds) && seconds >= 3 ? Math.round(seconds) : undefined, maxLines: Number(body.maxLines) || undefined, names: stringList(body.names, 20, 120), facts: stringList(body.facts, 20, 200), explicit: body.explicit === true, ...(body.sfx === true ? { effects: sfxHelp(await effectNames()) } : {}) },
        { provider, textModel, station, personas: personas.map, template });
      return Response.json({ text: out.text, filledIn: out.text, raw: out.raw, lines: out.lines, ...(out.copied.length ? { copiedExample: out.copied } : {}), ...(out.dropped ? { droppedLines: out.dropped } : {}), provider, ...(textModel ? { textModel } : {}) });
    } catch (err) {
      return Response.json({ error: `Script drafting failed: ${(err as Error).message}`, ...(err instanceof DraftFormatError ? { reply: err.reply } : {}) }, { status: 502 });
    }
  });
}

// A saved script with its {{placeholders}} filled in for a moment (`at`), without speaking it: what a schedule or a dynamic slot would say.
async function filled(req: Request, who: Principal): Promise<Response> {
  const body = await readJson(req);
  const scriptId = typeof body?.scriptId === "string" ? body.scriptId : "";
  const script = scriptId ? await getScript(scriptId) : null;
  if (!script || !canView(who, script.ownerId)) return Response.json({ error: "Script not found" }, { status: 404 });
  const stationId = typeof body?.station === "string" ? body.station : script.stationId;
  const station = stationId ? await getStation(stationId) : null;
  return withKeys(who, stationId, async () => {
    const out = await renderTemplate(script.text, contextFor({ station, now: atOf(body?.at) }));
    return Response.json({ filledIn: out.text, raw: script.text, kind: script.kind, cast: script.cast, gapSeconds: script.gapSeconds, ...(out.missing.length ? { templateMissing: out.missing } : {}) });
  });
}
