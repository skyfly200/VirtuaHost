// Google Drive as a sound library, read through a service account (no one has to sign in on the server).
//
//   GOOGLE_SERVICE_ACCOUNT_JSON  the service account's key file contents (raw JSON or base64 of it)
//   GDRIVE_SFX_FOLDER            folder id (or its full URL) holding sound effects
//   GDRIVE_MUSIC_FOLDER          folder id (or URL) holding music beds
//
// Share each folder with the service account's email address (Viewer is enough). Read-only: nothing is ever written to Drive.
import { createSign } from "node:crypto";
import { AUDIO_FILE, MAX_FETCH_BYTES, mimeOf, nameOf, type LibraryItem, type LibraryKind, type LibrarySource } from "./types.js";

const env = (name: string) => process.env[name]?.trim() ?? "";
const folderFor = (kind: LibraryKind): string => {
  const raw = env(kind === "sfx" ? "GDRIVE_SFX_FOLDER" : "GDRIVE_MUSIC_FOLDER");
  return /\/folders\/([A-Za-z0-9_-]+)/.exec(raw)?.[1] ?? (/^[A-Za-z0-9_-]{10,}$/.test(raw) ? raw : "");
};

interface Account { client_email: string; private_key: string; token_uri?: string }
function account(): Account | null {
  const raw = env("GOOGLE_SERVICE_ACCOUNT_JSON");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8")) as Account;
    return parsed.client_email && parsed.private_key ? parsed : null;
  } catch {
    return null;
  }
}

const b64url = (value: string | Buffer) => Buffer.from(value).toString("base64url");
let token: { value: string; expires: number } | undefined;

async function accessToken(): Promise<string> {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  const acct = account();
  if (!acct) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is missing or not valid");
  const now = Math.floor(Date.now() / 1000);
  const uri = acct.token_uri ?? "https://oauth2.googleapis.com/token";
  const unsigned = `${b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${b64url(JSON.stringify({ iss: acct.client_email, scope: "https://www.googleapis.com/auth/drive.readonly", aud: uri, iat: now, exp: now + 3600 }))}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(acct.private_key);
  const res = await fetch(uri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${unsigned}.${b64url(signature)}` }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !body.access_token) throw new Error(`Google sign-in failed: ${body.error_description ?? res.status}`);
  token = { value: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return token.value;
}

export const gdrive: LibrarySource = {
  id: "gdrive",
  label: "Google Drive",
  kinds: () => (account() ? (["sfx", "music"] as const).filter((k) => folderFor(k)) : []),

  async list(kind) {
    const items: LibraryItem[] = [];
    let pageToken: string | undefined;
    do {
      const url = new URL("https://www.googleapis.com/drive/v3/files");
      url.searchParams.set("q", `'${folderFor(kind)}' in parents and trashed = false`);
      url.searchParams.set("fields", "nextPageToken, files(id, name, mimeType, size)");
      url.searchParams.set("pageSize", "200");
      url.searchParams.set("supportsAllDrives", "true");
      url.searchParams.set("includeItemsFromAllDrives", "true");
      if (pageToken) url.searchParams.set("pageToken", pageToken);
      const res = await fetch(url, { headers: { authorization: `Bearer ${await accessToken()}` }, signal: AbortSignal.timeout(15_000) });
      const body = (await res.json().catch(() => ({}))) as { files?: Array<{ id: string; name: string; size?: string }>; nextPageToken?: string; error?: { message?: string } };
      if (!res.ok) throw new Error(`Google Drive: ${body.error?.message ?? res.status} (is the folder shared with the service account?)`);
      for (const f of body.files ?? []) {
        if (!AUDIO_FILE.test(f.name) || !nameOf(f.name)) continue;
        items.push({ source: "gdrive", kind, name: nameOf(f.name), file: f.name, ...(f.size ? { size: Number(f.size) } : {}), ref: f.id });
      }
      pageToken = body.nextPageToken;
    } while (pageToken && items.length < 1000);
    return items;
  },

  async fetch(item) {
    if (item.size !== undefined && item.size > MAX_FETCH_BYTES) throw new Error("File is too large to pass through the site (about 5 MB at most)");
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(item.ref)}?alt=media&supportsAllDrives=true`, {
      headers: { authorization: `Bearer ${await accessToken()}` },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) throw new Error(`Google Drive returned ${res.status}`);
    const data = await res.arrayBuffer();
    if (data.byteLength > MAX_FETCH_BYTES) throw new Error("File is too large to pass through the site (about 5 MB at most)");
    return { data, mimeType: mimeOf(item.file) };
  },
};
