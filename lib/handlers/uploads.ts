import { randomUUID } from "node:crypto";
import { authorize, canModify, ownerFor, type Principal } from "../auth.js";
import { clearLibraryCache, listLibrary } from "../library/index.js";
import { KINDS, nameOf } from "../library/types.js";
import { deleteUpload, getUploadMeta, isKind, listUploads, saveUpload, uniqueName, updateUpload, type UploadMeta } from "../library/uploads.js";
import { SFX_NAMES } from "../sfx-mix.js";

// POST   /api/uploads          the audio file as the body (audio/wav or audio/mpeg); x-upload-meta is URI-encoded JSON { kind, name?, file?, seconds? }
// GET    /api/uploads          { uploads: [{ id, name, kind, file, size, seconds, ownerId, createdAt, canEdit }] }
// PATCH  /api/uploads/:id      { name?, kind? }   (its owner or an admin)
// DELETE /api/uploads/:id                         (its owner or an admin)
// Files appear in the sound library (GET /api/library) and are used by name in tags: [music:name vol=0.2], [intro:name], [outro:name], [sfx:name].
const MAX_BYTES = 5_500_000;                      // Netlify functions accept request bodies of about 6 MB
const maxPerUser = () => { const n = Number(process.env.UPLOAD_MAX_PER_USER); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 50; };

const view = (m: UploadMeta, who: Principal) => ({ id: m.id, name: m.name, kind: m.kind, file: m.file, size: m.size, mimeType: m.mimeType, ...(m.seconds ? { seconds: m.seconds } : {}), ...(m.ownerId ? { ownerId: m.ownerId } : {}), createdAt: m.createdAt, canEdit: canModify(who, m.ownerId) });

async function takenNames(kind: string, except?: string): Promise<string[]> {
  const mine = (await listUploads()).filter((u) => u.kind === kind && u.id !== except).map((u) => u.name);
  const others = kind === "sfx" || kind === "music" ? (await listLibrary(kind)).items.map((i) => i.name) : [];
  return [...mine, ...others, ...(kind === "sfx" ? SFX_NAMES : [])];
}

export async function handleUploads(req: Request, id?: string): Promise<Response> {
  const { who, denied } = await authorize(req);
  if (denied) return denied;

  if (!id) {
    if (req.method === "GET") return Response.json({ uploads: (await listUploads()).map((m) => view(m, who)) });
    if (req.method === "POST") return save(req, who);
    return new Response("Method Not Allowed", { status: 405 });
  }
  const meta = await getUploadMeta(id);
  if (!meta) return Response.json({ error: "Upload not found" }, { status: 404 });
  if (req.method === "DELETE") {
    if (!canModify(who, meta.ownerId)) return Response.json({ error: "Only its owner or an admin can delete this file" }, { status: 403 });
    await deleteUpload(id); clearLibraryCache();
    return new Response(null, { status: 204 });
  }
  if (req.method === "PATCH") {
    if (!canModify(who, meta.ownerId)) return Response.json({ error: "Only its owner or an admin can change this file" }, { status: 403 });
    let body: Record<string, unknown>;
    try { body = (await req.json()) as Record<string, unknown>; } catch { return Response.json({ error: "Request body must be JSON" }, { status: 400 }); }
    const next = { ...meta };
    if (body.kind !== undefined) { if (!isKind(body.kind)) return Response.json({ error: `kind must be one of: ${KINDS.join(", ")}` }, { status: 400 }); next.kind = body.kind; }
    if (typeof body.name === "string" && body.name.trim()) {
      const wanted = nameOf(body.name);
      if (!wanted) return Response.json({ error: "Use letters and numbers in the name" }, { status: 400 });
      next.name = wanted;
    }
    if (next.name !== meta.name || next.kind !== meta.kind) {
      if ((await takenNames(next.kind, id)).includes(next.name)) return Response.json({ error: `There is already a ${next.kind} called "${next.name}"` }, { status: 409 });
    }
    await updateUpload(next); clearLibraryCache();
    return Response.json(view(next, who));
  }
  return new Response("Method Not Allowed", { status: 405 });
}

async function save(req: Request, who: Principal): Promise<Response> {
  const mimeType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mimeType !== "audio/wav" && mimeType !== "audio/mpeg") return Response.json({ error: "Send the audio as audio/wav or audio/mpeg" }, { status: 400 });
  const audio = Buffer.from(await req.arrayBuffer());
  if (!audio.length) return Response.json({ error: "No audio received" }, { status: 400 });
  if (audio.length > MAX_BYTES) return Response.json({ error: "The file is too large (about 5 MB at most; the page shortens long files for you)" }, { status: 413 });
  const looksRight = mimeType === "audio/wav" ? audio.subarray(0, 4).toString("latin1") === "RIFF" && audio.subarray(8, 12).toString("latin1") === "WAVE" : audio.subarray(0, 3).toString("latin1") === "ID3" || (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);
  if (!looksRight) return Response.json({ error: `That is not ${mimeType} audio` }, { status: 400 });

  let meta: Record<string, unknown>;
  try { meta = JSON.parse(decodeURIComponent(req.headers.get("x-upload-meta") ?? "{}")) as Record<string, unknown>; } catch { return Response.json({ error: "x-upload-meta must be URI-encoded JSON" }, { status: 400 }); }
  if (!isKind(meta.kind)) return Response.json({ error: `kind must be one of: ${KINDS.join(", ")}` }, { status: 400 });
  const file = (typeof meta.file === "string" ? meta.file : "").replace(/[\\/]/g, "_").slice(0, 120) || "upload";

  const cap = maxPerUser();
  if (who.role !== "admin" && (await listUploads()).filter((u) => u.ownerId === who.username).length >= cap) {
    return Response.json({ error: `You can keep at most ${cap} uploaded files. Delete one first, or ask an admin to raise UPLOAD_MAX_PER_USER.` }, { status: 429 });
  }
  const seconds = typeof meta.seconds === "number" && meta.seconds > 0 && meta.seconds < 3600 ? Math.round(meta.seconds * 10) / 10 : undefined;
  const m: UploadMeta = {
    id: randomUUID(), kind: meta.kind, name: uniqueName(typeof meta.name === "string" && meta.name.trim() ? meta.name : file.replace(/\.[^.]+$/, ""), await takenNames(meta.kind)),
    file, mimeType, size: audio.length, ...(seconds ? { seconds } : {}), ...(ownerFor(who) ? { ownerId: ownerFor(who) } : {}), createdAt: new Date().toISOString(),
  };
  await saveUpload(m, audio); clearLibraryCache();
  return Response.json(view(m, who), { status: 201 });
}
