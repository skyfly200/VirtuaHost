import { randomUUID } from "node:crypto";
import { getClip, listClips, saveClip } from "../store.js";
import { checkAuth } from "../auth.js";
import { sendToStation, stationConfigured } from "../station-send.js";
import type { ClipMetadata } from "../types.js";

const MAX_UPLOAD_BYTES = 5_500_000; // Netlify functions accept request bodies of about 6 MB

// Saves audio the browser has already made (a previewed clip with sound effects mixed in). The body is the audio itself;
// what it says is in the x-clip-meta header as URI-encoded JSON, because the body cannot carry both.
async function handleSave(req: Request): Promise<Response> {
  const mimeType = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (mimeType !== "audio/wav" && mimeType !== "audio/mpeg") {
    return Response.json({ error: "Send the audio as audio/wav or audio/mpeg" }, { status: 400 });
  }
  const audio = Buffer.from(await req.arrayBuffer());
  if (!audio.length) return Response.json({ error: "No audio received" }, { status: 400 });
  if (audio.length > MAX_UPLOAD_BYTES) return Response.json({ error: "The clip is too large to save (about 5 MB at most)" }, { status: 413 });
  const looksRight = mimeType === "audio/wav" ? audio.subarray(0, 4).toString("latin1") === "RIFF" : audio.subarray(0, 3).toString("latin1") === "ID3" || audio[0] === 0xff;
  if (!looksRight) return Response.json({ error: `That is not ${mimeType} audio` }, { status: 400 });

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(decodeURIComponent(req.headers.get("x-clip-meta") ?? "{}")) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "x-clip-meta must be URI-encoded JSON" }, { status: 400 });
  }
  const text = (key: string, max: number): string | undefined => (typeof meta[key] === "string" && meta[key] ? (meta[key] as string).slice(0, max) : undefined);
  const scriptText = text("scriptText", 2000);
  if (!scriptText) return Response.json({ error: "x-clip-meta needs scriptText" }, { status: 400 });
  const effects = Array.isArray(meta.effects) ? meta.effects.filter((e): e is string => typeof e === "string").map((e) => e.slice(0, 40)).slice(0, 20) : [];

  const id = randomUUID();
  const metadata: ClipMetadata = {
    id,
    createdAt: new Date().toISOString(),
    mode: meta.mode === "ai" ? "ai" : "say",
    input: text("input", 2000) ?? scriptText,
    scriptText,
    voice: text("voice", 60) ?? "",
    mimeType,
    byteSize: audio.length,
    ...(text("provider", 20) ? { provider: text("provider", 20) } : {}),
    ...(text("textModel", 100) ? { textModel: text("textModel", 100) } : {}),
    ...(text("speechModel", 100) ? { speechModel: text("speechModel", 100) } : {}),
    ...(text("tone", 100) ? { tone: text("tone", 100) } : {}),
    ...(text("format", 40) ? { format: text("format", 40) } : {}),
    ...(effects.length ? { effects } : {}),
  };
  await saveClip(id, audio, metadata);

  // Same as /api/generate: the clip is saved either way, a station problem is only reported.
  let handoff;
  if (meta.handoff !== false && stationConfigured()) {
    handoff = await sendToStation({
      clipId: id, audio, mimeType, title: scriptText,
      play: typeof meta.play === "boolean" ? meta.play : undefined,
      preempt: typeof meta.preempt === "boolean" ? meta.preempt : undefined,
    });
  }
  return Response.json({ id, audioUrl: `/api/clips/${id}`, ...(handoff ? { handoff } : {}) }, { status: 201 });
}

export async function handleClips(req: Request, id: string | undefined): Promise<Response> {
  const denied = checkAuth(req);
  if (denied) return denied;

  if (req.method === "POST" && !id) return handleSave(req);
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  if (!id) {
    const clips = await listClips();
    return Response.json({ clips });
  }

  const clip = await getClip(id);
  if (!clip) {
    return Response.json({ error: "Clip not found" }, { status: 404 });
  }

  return new Response(clip.data, {
    status: 200,
    headers: {
      "Content-Type": clip.metadata.mimeType,
      "Content-Length": String(clip.data.byteLength),
    },
  });
}
