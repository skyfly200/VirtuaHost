import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { getStation } from "./station-profile-store.js";
import type { KeyProvider, KeyScope } from "./credentials.js";

// AI provider keys that belong to a person or a station, kept in Netlify Blobs (store "secrets") and encrypted with AES-256-GCM.
//   SECRETS_KEY     32+ characters that protect the stored keys. Falls back to SESSION_SECRET, but then changing SESSION_SECRET
//                   (which signs everyone out) also makes every stored key unreadable; set SECRETS_KEY to keep them apart.
// A stored key is never sent back to the browser: only whether one is set and its last four characters.
export const PROVIDERS: KeyProvider[] = ["openrouter", "gemini", "elevenlabs"];
export type Owner = { kind: "user" | "station"; id: string };

interface Stored { ct: string; last4: string; updatedAt: string }
type Record_ = Partial<Record<KeyProvider, Stored>>;

const secret = () => (process.env.SECRETS_KEY?.length ?? 0) >= 32 ? process.env.SECRETS_KEY! : process.env.SESSION_SECRET ?? "";
export const keyStorageConfigured = (): boolean => secret().length >= 32;
const derive = () => scryptSync(secret(), "virtuahost-provider-keys", 32);

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", derive(), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(token: string): string | null {
  try {
    const [v, iv, tag, body] = token.split(".");
    if (v !== "v1") return null;
    const d = createDecipheriv("aes-256-gcm", derive(), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;                                   // wrong secret or tampered: treated as no key
  }
}

const store = () => getStore("secrets");
const keyOf = (o: Owner) => `keys/${o.kind}/${o.id}.json`;
const read = async (o: Owner): Promise<Record_> => ((await store().get(keyOf(o), { type: "json" })) as Record_ | null) ?? {};

export const validKey = (k: unknown): k is string => typeof k === "string" && k.trim().length >= 16 && k.trim().length <= 300 && /^[\x21-\x7e]+$/.test(k.trim());

export async function setProviderKey(owner: Owner, provider: KeyProvider, key: string): Promise<void> {
  const k = key.trim();
  await store().setJSON(keyOf(owner), { ...(await read(owner)), [provider]: { ct: encrypt(k), last4: k.slice(-4), updatedAt: new Date().toISOString() } });
}

export async function clearProviderKey(owner: Owner, provider: KeyProvider): Promise<void> {
  const current = await read(owner);
  delete current[provider];
  if (Object.keys(current).length) await store().setJSON(keyOf(owner), current);
  else await store().delete(keyOf(owner));
}

/** What the UI may know: which providers have a key, and its last four characters. */
export async function describeKeys(owner: Owner): Promise<Partial<Record<KeyProvider, { last4: string; updatedAt: string }>>> {
  const rec = await read(owner);
  return Object.fromEntries(PROVIDERS.flatMap((p) => (rec[p] ? [[p, { last4: rec[p]!.last4, updatedAt: rec[p]!.updatedAt }]] : [])));
}

async function decrypted(owner: Owner): Promise<Partial<Record<KeyProvider, string>>> {
  if (!keyStorageConfigured()) return {};
  const rec = await read(owner);
  return Object.fromEntries(PROVIDERS.flatMap((p) => { const v = rec[p] ? decrypt(rec[p]!.ct) : null; return v ? [[p, v]] : []; }));
}

/**
 * Works out which keys and models apply to a request: the person's key beats the station's, which beats the site's (no entry here).
 * Never throws: with no Blobs (a local run) the site keys are used.
 */
export async function resolveScope(username: string | undefined, stationId: string | undefined): Promise<KeyScope> {
  const scope: KeyScope = { keys: {}, source: {} };
  try {
    const station = stationId && stationId !== "default" ? await getStation(stationId) : null;
    if (station?.textModels?.length) scope.textModels = station.textModels;
    if (station?.speechModels?.length) scope.speechModels = station.speechModels;
    const none: Partial<Record<KeyProvider, string>> = {};
    const [fromStation, fromUser] = await Promise.all([
      station ? decrypted({ kind: "station", id: station.id }) : none,
      username && username !== "api-key" && username !== "local" ? decrypted({ kind: "user", id: username }) : none,
    ]);
    for (const p of PROVIDERS) {
      if (fromStation[p]) { scope.keys[p] = fromStation[p]; scope.source[p] = "station"; }
      if (fromUser[p]) { scope.keys[p] = fromUser[p]; scope.source[p] = "user"; }
    }
  } catch {
    // no Blobs: site keys only
  }
  return scope;
}
