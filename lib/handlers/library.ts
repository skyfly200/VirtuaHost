import { checkAuth } from "../auth.js";
import { configuredSources, fetchLibraryItem, libraryFeatures, listLibrary } from "../library/index.js";
import { KINDS, type LibraryKind } from "../library/types.js";

// GET /api/library?kind=sfx|music  -> { items: [{ source, kind, name, file, size }], errors, sources }
// GET /api/library/:source/:kind/:name -> the audio file
export async function handleLibrary(req: Request, params: { source?: string; kind?: string; name?: string }): Promise<Response> {
  const denied = await checkAuth(req);
  if (denied) return denied;
  if (req.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

  if (!params.source) {
    if (!configuredSources().length) {
      return Response.json({ items: [], errors: [], ...libraryFeatures(), warning: "No library is connected. Set the OwnCloud or Google Drive variables (see docs/LIBRARY.md)." });
    }
    const kindParam = new URL(req.url).searchParams.get("kind");
    if (kindParam && !KINDS.includes(kindParam as LibraryKind)) return Response.json({ error: "kind must be sfx or music" }, { status: 400 });
    const wanted = kindParam ? [kindParam as LibraryKind] : [...KINDS];
    const lists = await Promise.all(wanted.map((k) => listLibrary(k)));
    return Response.json({
      items: lists.flatMap((l) => l.items.map(({ ref: _ref, ...item }) => item)),
      errors: lists.flatMap((l) => l.errors),
      ...libraryFeatures(),
    });
  }

  try {
    const file = await fetchLibraryItem(params.source, params.kind as LibraryKind, params.name ?? "");
    if (!file) return Response.json({ error: "Not found in the library" }, { status: 404 });
    return new Response(file.data, { headers: { "content-type": file.mimeType, "content-length": String(file.data.byteLength), "cache-control": "private, max-age=300" } });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
