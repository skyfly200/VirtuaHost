// Hands a freshly generated clip to the station server (Chips Voice, running next to Icecast/Liquidsoap),
// which stores it in its library and can put it on air. The generator never talks to Liquidsoap itself.
//
//   STATION_URL           public https address of the station server, e.g. https://radio.example.com
//   STATION_INGEST_TOKEN  the station's INGEST_TOKEN (it can only deliver audio, nothing else)
//   STATION_AUTOPLAY      "true" to put every generated clip on air unless the request says play:false
//   STATION_PREEMPT       "true" to let those clips interrupt a live DJ unless the request says otherwise

export interface HandoffOptions {
  title: string;
  text: string;
  play: boolean;
  preempt: boolean;
}

export interface HandoffResult {
  sent: boolean;
  clipId?: string;
  played?: boolean;
  reason?: string;
  error?: string;
}

export function handoffConfigured(): boolean {
  return Boolean(process.env.STATION_URL && process.env.STATION_INGEST_TOKEN);
}

export function handoffDefaults(): { play: boolean; preempt: boolean } {
  return {
    play: process.env.STATION_AUTOPLAY === "true",
    preempt: process.env.STATION_PREEMPT === "true",
  };
}

interface StationReply {
  clip?: { id?: string };
  played?: boolean;
  reason?: string;
  error?: string;
}

// Never throws: the clip is already saved, so a station that is down must not turn a good generation into a failure.
export async function pushToStation(wav: Buffer, options: HandoffOptions): Promise<HandoffResult> {
  const base = (process.env.STATION_URL ?? "").replace(/\/+$/, "");
  const token = process.env.STATION_INGEST_TOKEN ?? "";
  if (!base || !token) {
    return { sent: false, error: "STATION_URL and STATION_INGEST_TOKEN are not set" };
  }

  // The token travels in a header, so plain http is only acceptable for a server on this same machine.
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { sent: false, error: "STATION_URL is not a valid URL" };
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    return { sent: false, error: "STATION_URL must use https" };
  }

  const query = new URLSearchParams({ source: "virtuahost" });
  if (options.play) query.set("play", "true");
  if (options.play && options.preempt) query.set("preempt", "true");

  try {
    const res = await fetch(`${base}/ingest?${query.toString()}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "audio/wav",
        // Header values must be plain ASCII, so the text travels percent-encoded.
        "X-Title": encodeURIComponent(options.title.slice(0, 120)),
        "X-Text": encodeURIComponent(options.text.slice(0, 1000)),
      },
      body: new Uint8Array(wav),
      signal: AbortSignal.timeout(15_000),
    });

    let body: StationReply = {};
    try {
      body = (await res.json()) as StationReply;
    } catch {
      // not JSON; handled by the status check below
    }
    if (!res.ok) {
      return { sent: false, error: body.error ?? `station returned ${res.status}` };
    }
    return { sent: true, clipId: body.clip?.id, played: body.played ?? false, reason: body.reason };
  } catch (err) {
    return { sent: false, error: `could not reach the station: ${(err as Error).message}` };
  }
}
