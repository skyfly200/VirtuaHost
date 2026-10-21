import { createHash } from "node:crypto";
import { apiKey } from "./credentials.js";

// ElevenLabs as a speech engine, mainly so a person's or station's CLONED voices can be used (OpenRouter cannot reach them).
//   ELEVENLABS_API_KEY   the site's key; a person or station can save their own (lib/provider-keys.ts), which wins
//   ELEVENLABS_VOICES    optional "Rocky=<voice id>,Britta=<voice id>" names for voices; the same format the Chips Voice server uses
// Speech models are listed as "elevenlabs/<model id>" (for example elevenlabs/eleven_multilingual_v2). The voice can be a voice name
// from the account (clones are listed first) or a raw voice id. Writing the words still uses OpenRouter or Gemini.
//
// NOT VERIFIED against the live service (it could not be reached while this was written): GET /v1/voices, and
// POST /v1/text-to-speech/{voice_id} with { text, model_id } returning MP3, follow ElevenLabs' public API documentation.
export const ELEVEN_PREFIX = "elevenlabs/";
export const isElevenModel = (id: string | undefined): boolean => Boolean(id && id.startsWith(ELEVEN_PREFIX));
export const elevenConfigured = (): boolean => Boolean(apiKey("elevenlabs"));

export const ELEVEN_MODELS = ["eleven_flash_v2_5", "eleven_turbo_v2_5", "eleven_multilingual_v2"];
const BASE = () => (process.env.ELEVENLABS_BASE_URL || "https://api.elevenlabs.io").replace(/\/+$/, "");
const VOICE_ID = /^[A-Za-z0-9]{16,40}$/;

export interface ElevenVoice { id: string; name: string; category: string }

export function parseNamedVoices(raw: string | undefined = process.env.ELEVENLABS_VOICES): ElevenVoice[] {
  return (raw ?? "").split(",").flatMap((entry) => {
    const at = entry.indexOf("=");
    const name = entry.slice(0, at).trim();
    const id = entry.slice(at + 1).trim();
    return at > 0 && name && VOICE_ID.test(id) ? [{ id, name, category: "named" }] : [];
  });
}

let cache = new Map<string, { at: number; voices: ElevenVoice[] }>();
const TTL_MS = 5 * 60_000;
export const resetVoiceCache = (): void => { cache = new Map(); };

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: { message?: string } | string };
    const detail = typeof body.detail === "string" ? body.detail : body.detail?.message;
    if (detail) return `${detail} (ElevenLabs ${res.status})`;
  } catch {
    // not JSON
  }
  return `ElevenLabs returned ${res.status}`;
}

/** The voices on the account behind the key in scope: cloned and generated voices first, then the rest. Never throws. */
export async function listVoices(): Promise<ElevenVoice[]> {
  const key = apiKey("elevenlabs");
  if (!key) return parseNamedVoices();
  const id = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.voices;
  let voices: ElevenVoice[] = [];
  try {
    const res = await fetch(`${BASE()}/v1/voices`, { headers: { "xi-api-key": key }, signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const body = (await res.json()) as { voices?: Array<{ voice_id?: unknown; name?: unknown; category?: unknown }> };
      voices = (body.voices ?? []).flatMap((v) => (typeof v.voice_id === "string" && typeof v.name === "string" ? [{ id: v.voice_id, name: v.name, category: typeof v.category === "string" ? v.category : "" }] : []));
    }
  } catch {
    // unreachable: only the named voices from the environment are offered
  }
  const mine = (c: string) => (c === "cloned" || c === "generated" || c === "professional" ? 0 : 1);
  voices.sort((a, b) => mine(a.category) - mine(b.category) || a.name.localeCompare(b.name));
  const all = [...parseNamedVoices().filter((n) => !voices.some((v) => v.id === n.id)), ...voices];
  cache.set(id, { at: Date.now(), voices: all });
  return all;
}

/** A voice name or id -> the voice id to send. With no voice given, the first cloned voice (else the first voice). */
export async function resolveVoice(requested: string | undefined): Promise<{ id: string; name: string } | { error: string }> {
  const wanted = requested?.trim();
  const voices = await listVoices();
  if (wanted) {
    const named = voices.find((v) => v.name.toLowerCase() === wanted.toLowerCase() || v.id === wanted);
    if (named) return { id: named.id, name: named.name };
    if (VOICE_ID.test(wanted)) return { id: wanted, name: wanted };
    return { error: `No ElevenLabs voice called "${wanted.slice(0, 40)}" on this account. Choose one from the voice list, or paste a voice id.` };
  }
  const first = voices[0];
  return first ? { id: first.id, name: first.name } : { error: "Choose an ElevenLabs voice (none could be listed for this key)" };
}

export async function elevenSpeech(options: { model: string; voice?: string; text: string }): Promise<{ audio: Buffer; voice: string }> {
  const key = apiKey("elevenlabs");
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set (or save an ElevenLabs key in the app)");
  const voice = await resolveVoice(options.voice);
  if ("error" in voice) throw new Error(voice.error);
  const res = await fetch(`${BASE()}/v1/text-to-speech/${encodeURIComponent(voice.id)}?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": key, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify({ text: options.text, model_id: options.model.slice(ELEVEN_PREFIX.length) }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(await errorMessage(res));
  const audio = Buffer.from(await res.arrayBuffer());
  if (!audio.length) throw new Error("ElevenLabs returned no audio");
  return { audio, voice: voice.name };
}
