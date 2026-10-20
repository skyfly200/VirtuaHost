// The station daemon: runs next to Icecast and Liquidsoap, asks the site for clips to play, and puts them on air.
// It only makes outbound HTTPS calls, so the station needs no public address, no certificate and no AI keys.
//
//   SITE_URL            the deployed site, https://your-site.netlify.app
//   STATION_KEY         the key set as STATION_KEY on the site (lets this daemon fetch queued clips and report back)
//   STATION_ID          the station profile id (from the site's Stations tab): this daemon then collects only that station's clips and ones with no station
//   STATION_DIR         where received clips are kept (default ./clips)
//   POLL_SECONDS        how often to ask for work (default 5)
//   KEEP_FILES          clips kept in STATION_DIR (default 200, oldest removed)
//   LIQUIDSOAP_HOST/PORT  Liquidsoap's telnet server (default 127.0.0.1:1234, see chips-voice/googleTextToSpeech1/radio.liq)
//   ICECAST_STATUS_URL  Icecast's status-json.xsl, used by the virtual host to see what is playing (default http://127.0.0.1:8000/status-json.xsl)
//   ICECAST_MOUNT / ICECAST_LIVE_MOUNT  the listener mount (/stream) and the live DJ mount (/live)
//   HOST_POLL_SECONDS   how often the virtual host looks at what is playing (default 2)
//   LIQUIDSOAP_QUEUE    queue for normal clips (default announce); LIQUIDSOAP_LIVE_QUEUE for preempting ones (default announce_live)
//
// Metadata (what the clip is, who it is about, when it expires) arrives with each item. It is written next to the clip as
// <id>.json for other systems, and passed to Liquidsoap as annotate metadata (title, artist, genre, comment, expires, ...) so it
// shows up in the stream's now-playing. A clip whose expiry has passed is never played: it is reported "skipped".
//
// Per item: download the audio, apply the requested effect with ffmpeg (the Chips Voice presets, e.g. "underground"; a failed
// effect plays the clip unprocessed), keep a copy, push it to Liquidsoap when it is meant for air, then report played or failed.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHostLoop, icecastReaders } from "./host.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

// Sends one command to Liquidsoap's telnet server and resolves with its reply.
export function liquidsoapCommand(command, { host = "127.0.0.1", port = 1234 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host);
    let reply = "";
    socket.setTimeout(5000, () => socket.destroy(new Error("liquidsoap timeout")));
    socket.on("connect", () => socket.write(`${command}\nexit\n`));
    socket.on("data", (data) => { reply += data; });
    socket.on("error", reject);
    socket.on("close", () => resolve(reply.replace(/\r?\nBye!\r?\n?$/, "").trim()));
  });
}

// "annotate:key=\"value\",...:/path" for Liquidsoap, so a clip's details become its metadata on air.
const quote = (v) => `"${String(v).replace(/[\r\n]+/g, " ").replace(/\\/g, "\\\\").replace(/"/g, '\\"').slice(0, 300)}"`;
export function annotateUri(file, info = {}, extra = {}) {
  const pairs = {
    title: info.title || (info.event && info.event.name) || extra.title || "",
    artist: info.artist || "",
    album: info.album || "",
    genre: info.kind || "",
    comment: extra.comment || "",
    expires: info.expiresAt || "",
    event: (info.event && info.event.name) || "",
    persona: info.persona || "",
    source: info.source || "",
  };
  const body = Object.entries(pairs).filter(([, v]) => v).map(([k, v]) => `${k}=${quote(v)}`).join(",");
  return body ? `annotate:${body}:${file}` : file;
}
const isExpired = (item, now) => { const at = Date.parse(item.expiresAt || (item.info && item.info.expiresAt) || ""); return Number.isFinite(at) && at <= now; };

// The Chips Voice effect presets, when the repository's chips-voice folder is alongside; otherwise effects are skipped.
export function loadFx() {
  try {
    const fx = createRequire(import.meta.url)(path.resolve(here, process.env.FX_LIB || "../chips-voice/googleTextToSpeech1/lib/fx.js"));
    return async (buffer, setting) => {
      const normalized = fx.normalizeFx(setting);
      return normalized ? fx.apply(buffer, normalized) : buffer;
    };
  } catch {
    return null;
  }
}

export function createDaemon({ site, key, dir, fetchImpl = fetch, command, applyFx = null, keep = 200, log = console.log, now = Date.now, stationId = "" }) {
  const base = site.replace(/\/+$/, "");
  const headers = { "x-station-key": key };
  fs.mkdirSync(dir, { recursive: true });

  const call = async (pathname, init = {}) => {
    const res = await fetchImpl(`${base}${pathname}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });
    if (!res.ok) throw new Error(`site returned ${res.status} for ${pathname}`);
    return res;
  };
  const ack = (id, status, error) => call("/api/station/ack", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, status, ...(error ? { error } : {}) }) });

  function prune() {
    const files = fs.readdirSync(dir).map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs })).sort((a, b) => b.t - a.t);
    for (const old of files.slice(keep * 2)) fs.rmSync(path.join(dir, old.f), { force: true });
  }

  // Fetches an item's audio, applies its effect, keeps a copy, and puts it on air when it is meant for air.
  // item: { id, title, audioUrl, fx?, play, preempt }
  async function deliver(item) {
    if (isExpired(item, now())) { log(`expired, not played: ${item.title.slice(0, 60)}`); return "expired"; }
    const res = await call(item.audioUrl);
    let audio = Buffer.from(await res.arrayBuffer());
    let ext = (res.headers.get("content-type") || "").includes("mpeg") ? "mp3" : "wav";
    if (item.fx && applyFx) {
      try { audio = Buffer.from(await applyFx(audio, item.fx)); ext = "mp3"; } catch (err) { log(`effect "${typeof item.fx === "string" ? item.fx : "custom"}" failed, playing the clip unprocessed: ${err.message}`); }
    }
    const file = path.resolve(dir, `${item.id}.${ext}`);
    fs.writeFileSync(file, audio);
    // The details beside the clip, for systems that read files rather than the stream.
    fs.writeFileSync(path.resolve(dir, `${item.id}.json`), JSON.stringify({ id: item.id, file: path.basename(file), title: item.title, play: item.play, preempt: item.preempt, fx: item.fx, expiresAt: item.expiresAt, ...(item.info || {}) }, null, 2));
    if (item.play) {
      const reply = await command(`${item.preempt ? "announce_live" : "announce"}.push ${annotateUri(file, item.info, { comment: item.title })}`);
      log(`on air: ${item.title.slice(0, 60)} (${reply})`);
    } else {
      log(`stored: ${item.title.slice(0, 60)}`);
    }
    prune();
    return "delivered";
  }

  // Handles at most one queued item. Returns "idle", "played" or "failed"; throws only when the site cannot be reached.
  async function tick() {
    const { item } = await (await call(`/api/station/next${stationId ? `?station=${encodeURIComponent(stationId)}` : ""}`)).json();
    if (!item) return "idle";
    try {
      if ((await deliver(item)) === "expired") { await ack(item.id, "skipped", "expired"); return "skipped"; }
      await ack(item.id, "played");
      return "played";
    } catch (err) {
      log(`failed: ${err.message}`);
      await ack(item.id, "failed", err.message).catch((e) => log(`could not report the failure: ${e.message}`));
      return "failed";
    }
  }

  // JSON calls to the site for other loops (the virtual host).
  const api = async (pathname, body) => (await call(pathname, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();

  return { tick, deliver, api };
}

async function main() {
  const site = process.env.SITE_URL;
  const key = process.env.STATION_KEY;
  if (!site || !key) { console.error("Set SITE_URL and STATION_KEY (see station-daemon/README.md)"); process.exit(1); }
  if (!/^https?:\/\//.test(site)) { console.error("SITE_URL must start with https://"); process.exit(1); }
  const live = { host: process.env.LIQUIDSOAP_HOST || "127.0.0.1", port: Number(process.env.LIQUIDSOAP_PORT) || 1234 };
  const queue = process.env.LIQUIDSOAP_QUEUE || "announce";
  const liveQueue = process.env.LIQUIDSOAP_LIVE_QUEUE || "announce_live";
  const applyFx = loadFx();
  if (!applyFx) console.log("chips-voice/ not found next to the daemon: effects are skipped");
  const daemon = createDaemon({
    site, key, stationId: process.env.STATION_ID || "", dir: path.resolve(process.env.STATION_DIR || "clips"), applyFx, keep: Number(process.env.KEEP_FILES) || 200,
    command: (cmd) => liquidsoapCommand(cmd.replace(/^announce_live\./, `${liveQueue}.`).replace(/^announce\./, `${queue}.`), live),
  });
  // The virtual host: switched on and configured from the site; this loop only runs the station's half of it.
  const icecast = icecastReaders({ url: process.env.ICECAST_STATUS_URL || "http://127.0.0.1:8000/status-json.xsl", mount: process.env.ICECAST_MOUNT || "/stream", liveMount: process.env.ICECAST_LIVE_MOUNT || "/live" });
  const hostLoop = createHostLoop({ api: daemon.api, nowPlaying: icecast.nowPlaying, isLive: icecast.isLive, deliver: daemon.deliver });
  const hostEvery = Math.max(1, Number(process.env.HOST_POLL_SECONDS) || 2) * 1000;
  (async () => { for (;;) { await hostLoop.tick(); await new Promise((r) => setTimeout(r, hostEvery)); } })();

  const every = Math.max(1, Number(process.env.POLL_SECONDS) || 5) * 1000;
  let wait = every;
  console.log(`station daemon: polling ${site} every ${every / 1000}s`);
  for (;;) {
    try {
      const outcome = await daemon.tick();
      wait = outcome === "idle" ? every : 250;           // more may be waiting: ask again soon
    } catch (err) {
      console.error(`cannot reach the site: ${err.message}`);
      wait = Math.min(wait * 2, 60_000);                  // back off while it is down
    }
    await new Promise((r) => setTimeout(r, wait));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
