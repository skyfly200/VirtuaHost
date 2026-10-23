import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { parseListing } from "../../lib/library/owncloud.js";
import { listLibrary, fetchLibraryItem, clearLibraryCache, libraryFeatures } from "../../lib/library/index.js";
import { handleLibrary } from "../../lib/handlers/library.js";
import { nameOf } from "../../lib/library/types.js";

const fetchMock = vi.fn();
const KEY = "test-access-key-0123456789";
const ocXml = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">
<d:response><d:href>/remote.php/dav/files/dj/VirtuaHost/sfx/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/dj/VirtuaHost/sfx/Big%20Ding.mp3</d:href><d:propstat><d:prop><d:getcontentlength>1234</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
<d:response><d:href>/remote.php/dav/files/dj/VirtuaHost/sfx/notes.txt</d:href><d:propstat><d:prop><d:getcontentlength>5</d:getcontentlength><d:resourcetype/></d:prop></d:propstat></d:response>
</d:multistatus>`;

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  clearLibraryCache();
  vi.stubEnv("ACCESS_KEY", KEY);
  for (const n of ["OWNCLOUD_URL", "OWNCLOUD_USER", "OWNCLOUD_PASSWORD", "OWNCLOUD_SFX_PATH", "OWNCLOUD_MUSIC_PATH", "GOOGLE_SERVICE_ACCOUNT_JSON", "GDRIVE_SFX_FOLDER", "GDRIVE_MUSIC_FOLDER"]) vi.stubEnv(n, "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

const useOwnCloud = () => {
  vi.stubEnv("OWNCLOUD_URL", "https://cloud.example.com/");
  vi.stubEnv("OWNCLOUD_USER", "dj");
  vi.stubEnv("OWNCLOUD_PASSWORD", "app-pass");
  vi.stubEnv("OWNCLOUD_SFX_PATH", "/VirtuaHost/sfx");
};
const useDrive = () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  vi.stubEnv("GOOGLE_SERVICE_ACCOUNT_JSON", Buffer.from(JSON.stringify({ client_email: "sa@proj.iam.gserviceaccount.com", private_key: privateKey })).toString("base64"));
  vi.stubEnv("GDRIVE_SFX_FOLDER", "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp?usp=sharing");
};

describe("names", () => {
  it("turns file names into tag names", () => {
    expect(nameOf("Big Ding!.mp3")).toBe("big-ding");
    expect(nameOf("   .wav")).toBe("");
  });
});

describe("OwnCloud", () => {
  it("reads a WebDAV listing, skipping folders and non-audio files", () => {
    expect(parseListing(ocXml).map((e) => [e.href.split("/").pop(), e.collection, e.size])).toEqual([["", true, undefined], ["Big Ding.mp3", false, 1234], ["notes.txt", false, 5]]);
  });

  it("lists with basic auth and fetches a listed file", async () => {
    useOwnCloud();
    fetchMock.mockResolvedValueOnce(new Response(ocXml, { status: 207 })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const { items } = await listLibrary("sfx");
    expect(items).toEqual([{ source: "owncloud", kind: "sfx", name: "big-ding", file: "Big Ding.mp3", size: 1234, ref: "Big Ding.mp3" }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://cloud.example.com/remote.php/dav/files/dj/VirtuaHost/sfx");
    expect(init.method).toBe("PROPFIND");
    expect(init.headers.authorization).toBe(`Basic ${Buffer.from("dj:app-pass").toString("base64")}`);

    const file = await fetchLibraryItem("owncloud", "sfx", "big-ding");
    expect(fetchMock.mock.calls[1][0]).toBe("https://cloud.example.com/remote.php/dav/files/dj/VirtuaHost/sfx/Big%20Ding.mp3");
    expect(file?.mimeType).toBe("audio/mpeg");
    expect(await fetchLibraryItem("owncloud", "sfx", "../../etc/passwd")).toBeNull();
  });

  it("reports a bad password instead of an empty library", async () => {
    useOwnCloud();
    fetchMock.mockResolvedValue(new Response("", { status: 401 }));
    const out = await listLibrary("sfx");
    expect(out.items).toEqual([]);
    expect(out.errors[0]).toMatch(/OwnCloud rejected/);
  });
});

describe("Google Drive", () => {
  it("signs in with the service account, lists the folder and downloads a file", async () => {
    useDrive();
    fetchMock
      .mockResolvedValueOnce(Response.json({ access_token: "tok", expires_in: 3600 }))
      .mockResolvedValueOnce(Response.json({ files: [{ id: "f1", name: "Whoosh Long.wav", size: "900" }, { id: "f2", name: "readme.pdf" }] }))
      .mockResolvedValueOnce(new Response(new Uint8Array([9, 9])));
    const { items } = await listLibrary("sfx");
    expect(items).toEqual([{ source: "gdrive", kind: "sfx", name: "whoosh-long", file: "Whoosh Long.wav", size: 900, ref: "f1" }]);
    const tokenCall = fetchMock.mock.calls[0];
    expect(String(tokenCall[1].body)).toContain("grant_type=urn");
    const listUrl = new URL(String(fetchMock.mock.calls[1][0]));
    expect(listUrl.searchParams.get("q")).toBe("'1AbCdEfGhIjKlMnOp' in parents and trashed = false");
    expect(fetchMock.mock.calls[1][1].headers.authorization).toBe("Bearer tok");

    const file = await fetchLibraryItem("gdrive", "sfx", "whoosh-long");
    expect(String(fetchMock.mock.calls[2][0])).toContain("/files/f1?alt=media");
    expect(file?.mimeType).toBe("audio/wav");
  });
});

describe("GET /api/library", () => {
  const get = (path = "", params = {}) => handleLibrary(new Request(`http://localhost/api/library${path}`, { headers: { "x-api-key": KEY } }), params);

  it("explains itself when no cloud folder is connected (uploads are always there)", async () => {
    const body = (await (await get()).json()) as { items: unknown[]; warning?: string };
    expect(body.items).toEqual([]);
    expect(body.warning).toMatch(/No cloud library/);
    expect(libraryFeatures().sources.map((s) => s.id)).toEqual(["uploads"]);
  });

  it("lists without leaking provider references, and serves a file", async () => {
    useOwnCloud();
    fetchMock.mockResolvedValueOnce(new Response(ocXml, { status: 207 })).mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
    const body = (await (await get("?kind=sfx")).json()) as { items: Array<Record<string, unknown>> };
    expect(body.items).toEqual([{ source: "owncloud", kind: "sfx", name: "big-ding", file: "Big Ding.mp3", size: 1234 }]);
    const res = await get("/owncloud/sfx/big-ding", { source: "owncloud", kind: "sfx", name: "big-ding" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect((await get("/owncloud/sfx/missing", { source: "owncloud", kind: "sfx", name: "missing" })).status).toBe(404);
    expect((await get("?kind=bogus")).status).toBe(400);
  });
});
