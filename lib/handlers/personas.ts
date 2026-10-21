import { authorize, canModify, canView, ownerFor, type Principal } from "../auth.js";
import { chargeAi } from "../quota.js";
import { activeProvider, complete, NO_PROVIDER_MESSAGE } from "../ai.js";
import { pickTextModel } from "../openrouter.js";
import { deletePersona, getPersona, listPersonas, newPersonaId, savePersona } from "../persona-store.js";
import { ID, PERSONA_SYSTEM_PROMPT, parsePersonaReply, personaPrompt, sanitizePersona, type Persona } from "../personas.js";

const readJson = async (req: Request): Promise<unknown | undefined> => {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
};

// GET /api/personas, GET|PUT|DELETE /api/personas/:id, POST /api/personas (create), POST /api/personas/generate (AI draft, not saved).
export async function handlePersonas(req: Request, id: string | undefined): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;

  if (id === "generate") return req.method === "POST" ? draft(req, who) : new Response("Method Not Allowed", { status: 405 });

  if (!id) {
    if (req.method === "GET") return Response.json({ personas: (await listPersonas()).filter((p) => canView(who, p.ownerId)) });
    if (req.method === "POST") {
      const clean = sanitizePersona(await readJson(req));
      if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
      const persona: Persona = { id: newPersonaId(clean.persona.name), ...clean.persona, ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}) };
      await savePersona(persona);
      return Response.json({ persona }, { status: 201 });
    }
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!ID.test(id)) return Response.json({ error: "Persona not found" }, { status: 404 });
  const existing = await getPersona(id);
  if (!existing || !canView(who, existing.ownerId)) return Response.json({ error: "Persona not found" }, { status: 404 });

  if (req.method === "GET") return Response.json({ persona: existing });
  if (existing.builtin) return Response.json({ error: "Built-in personas cannot be changed; duplicate it to make your own" }, { status: 403 });
  if (!canModify(who, existing.ownerId)) return Response.json({ error: "That persona is shared; duplicate it to make your own" }, { status: 403 });

  if (req.method === "PUT") {
    const clean = sanitizePersona(await readJson(req));
    if ("error" in clean) return Response.json({ error: clean.error }, { status: 400 });
    const persona: Persona = { id, ...clean.persona, ...(existing.ownerId ? { ownerId: existing.ownerId } : {}) };
    await savePersona(persona);
    return Response.json({ persona });
  }
  if (req.method === "DELETE") {
    await deletePersona(id);
    return new Response(null, { status: 204 });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

// Asks the writing model for a persona from a short description. The result is a draft for the UI to edit and save.
async function draft(req: Request, who: Principal): Promise<Response> {
  const body = (await readJson(req)) as { description?: unknown; textModel?: unknown } | undefined;
  const description = typeof body?.description === "string" ? body.description.trim().slice(0, 600) : "";
  if (!description) return Response.json({ error: "Describe the host you want, for example: a sleepy night-owl who loves jazz" }, { status: 400 });

  const provider = activeProvider();
  if (!provider) return Response.json({ error: NO_PROVIDER_MESSAGE }, { status: 503 });
  let textModel: string | undefined;
  if (provider === "openrouter") {
    const t = pickTextModel(typeof body?.textModel === "string" ? body.textModel : undefined);
    if ("error" in t) return Response.json({ error: t.error }, { status: 400 });
    textModel = t.model;
  }

  const over = await chargeAi(who);
  if (over) return over;
  let reply: string;
  try {
    reply = await complete({ system: PERSONA_SYSTEM_PROMPT, prompt: personaPrompt(description, process.env.STATION_NAME || "the station"), provider, textModel });
  } catch (err) {
    return Response.json({ error: `Persona generation failed: ${(err as Error).message}` }, { status: 502 });
  }
  const parsed = parsePersonaReply(reply);
  if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 502 });
  return Response.json({ persona: parsed.persona });
}
