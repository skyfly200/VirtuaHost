import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { formatIso } from "../timezones.js";
import type { HubDb } from "./db.js";

// What a pull station (a RadioDJ PC behind NAT) does against the hub: send a heartbeat, ask for finished clips, download one, say what
// happened to it. These are the same four calls as chips-voice/hub (hub.js, jit.js), on the same tables and record shapes, so the hub
// and the site can run side by side. Each change is one conditional statement, so two function runs at once cannot both win:
//   * a queued clip is either acknowledged by the station or expired by the sweep, whichever statement runs first;
//   * a second acknowledgement of the same clip is a no-op.

export class PullError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const MODE_FRESH_MS = 10 * 60_000;
const ACK_STATUSES = ["inserted", "shadow", "skipped", "failed"] as const;
const REPORT_KEYS = ["kind", "name", "mode", "machineTz", "broadcastTz", "pcOffsetMinutes", "nowPlaying", "stream", "shadow", "killSwitch", "playlist", "lastWatchdogRestart", "capabilities", "reachable", "needsLiveVerification"];

const hex = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (v: unknown, n: number) => (v === undefined || v === null ? "" : String(v)).slice(0, n);

/** The station record when `given` is its pull key. Unknown station and wrong key look the same on purpose. */
export async function authenticateStation(db: HubDb, stationId: string, given: string): Promise<Doc> {
  const { rows } = await db.query("select doc from hub_stations where id = $1", [stationId]);
  const doc = rows[0]?.doc as Doc | undefined;
  const want = typeof doc?.pullKeyHash === "string" ? doc.pullKeyHash : "";
  if (!doc || !want || !given) throw new PullError("unauthorized", 401);
  const a = Buffer.from(hex(given));
  const b = Buffer.from(want);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new PullError("unauthorized", 401);
  return doc;
}

async function jitSettings(db: HubDb): Promise<Doc> {
  const { rows } = await db.query("select doc from hub_state where key = 'jit'", []);
  return (rows[0]?.doc as Doc | undefined)?.settings ?? {};
}

function cleanReport(r: Doc): Doc {
  const out: Doc = {};
  for (const k of REPORT_KEYS) if (r[k] !== undefined) out[k] = r[k];
  out.next = (Array.isArray(r.next) ? r.next : []).slice(0, 10).map((n: Doc) => ({ artist: text(n?.artist, 120), title: text(n?.title, 160) }));
  out.warnings = (Array.isArray(r.warnings) ? r.warnings : []).slice(0, 10).map((w: Doc) => ({ code: text(w?.code, 40), level: w?.level === "error" ? "error" : "warn", message: text(w?.message, 300) }));
  return JSON.parse(JSON.stringify(out).slice(0, 20000));
}

async function audit(db: HubDb, stationId: string, action: string, target: string, result: string, detail: string, now: number): Promise<void> {
  const entry = { at: now, who: `station:${stationId}`, action, target: text(target, 80), result: text(result, 40), detail: text(detail, 300) };
  await db.query("insert into hub_audit (id, pos, doc) select $1, coalesce(max(pos), -1) + 1, $2::jsonb from hub_audit", [randomUUID(), JSON.stringify(entry)]);
}

/** Remembers the station's report (its mode decides whether clips are handed out) and says whether a kill switch is on. */
export async function recordHeartbeat(db: HubDb, station: Doc, status: unknown, now: number): Promise<{ ok: true; time: number; killed: boolean }> {
  if (!status || typeof status !== "object" || Array.isArray(status)) throw new PullError("send { status } (the agent's /agent/status)", 400);
  const report = cleanReport(status as Doc);
  const doc = { at: now, mode: typeof report.mode === "string" ? report.mode : "unknown", report };
  await db.query(
    "insert into hub_state (key, doc, updated_at) values ($1, $2::jsonb, now()) on conflict (key) do update set doc = excluded.doc, updated_at = now()",
    [`report:${station.id}`, JSON.stringify(doc)],
  );
  const settings = await jitSettings(db);
  return { ok: true, time: now, killed: Boolean(settings.kill?.on || station.jit?.kill) };
}

async function modeOf(db: HubDb, stationId: string, now: number): Promise<string> {
  const { rows } = await db.query("select doc from hub_state where key = $1", [`report:${stationId}`]);
  const r = rows[0]?.doc as Doc | undefined;
  return r && now - Number(r.at) < MODE_FRESH_MS && typeof r.mode === "string" ? r.mode : "unknown";
}

/** Clips waiting for this station. Clips past their time are expired first (and their line falls back to the planned clip). */
export async function getQueue(db: HubDb, station: Doc, now: number): Promise<Doc> {
  const settings = await jitSettings(db);
  const mode = await modeOf(db, station.id, now);
  const killed = Boolean(settings.kill?.on || station.jit?.kill);
  if (killed) return { killed: true, reason: settings.kill?.on ? settings.kill.reason || "global kill switch" : "station kill switch", mode, items: [] };
  if (mode === "live-show") return { killed: false, mode, items: [], note: "a live show is on air: nothing is handed out" };

  const reason = "the station did not pick the clip up in time";
  await db.query(
    `with expired as (
       update hub_jit_queue set doc = jsonb_set(doc, '{state}', '"expired"'), updated_at = now()
       where doc->>'stationId' = $1 and doc->>'state' = 'queued' and (doc->>'expiresAt')::bigint <= $2::bigint
       returning doc->>'itemId' as item_id)
     update hub_jit_items i set updated_at = now(), doc = jsonb_set(jsonb_set(jsonb_set(jsonb_set(i.doc, '{state}', '"fallback"'), '{reason}', to_jsonb($3::text)), '{updatedAt}', to_jsonb($2::bigint)),
       '{log}', coalesce(i.doc->'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', $2::bigint, 'step', 'fallback', 'ok', false, 'detail', $3::text)))
     from expired e where i.id = e.item_id and i.doc->>'state' = 'queued'`,
    [station.id, String(now), reason],
  );
  const { rows } = await db.query(
    "select doc from hub_jit_queue where doc->>'stationId' = $1 and doc->>'state' = 'queued' and (doc->>'expiresAt')::bigint > $2::bigint order by pos, id",
    [station.id, String(now)],
  );
  const zone = typeof station.broadcastTz === "string" && station.broadcastTz ? station.broadcastTz : "UTC";
  const items = rows.map(({ doc: q }) => ({
    id: q.id, kind: q.kind, title: q.title, text: q.text, startsAt: q.startsAt, startsAtIso: formatIso(Number(q.startsAt), zone),
    expiresAt: new Date(Number(q.expiresAt)).toISOString(), ahead: q.ahead, replace: q.replace, sha256: q.sha256, bytes: q.bytes, mime: q.mime,
  }));
  return { killed: false, mode, items };
}

/** The audio for one of this station's queue items; `read` fetches the bytes by content hash (Netlify Blobs in production). */
export async function getAudio(db: HubDb, station: Doc, queueId: string, read: (hash: string) => Promise<ArrayBuffer | null>): Promise<{ bytes: ArrayBuffer; mime: string; sha256: string }> {
  const { rows } = await db.query("select doc from hub_jit_queue where id = $1 and doc->>'stationId' = $2", [queueId, station.id]);
  const q = rows[0]?.doc as Doc | undefined;
  if (!q) throw new PullError("no such queue item", 404);
  const bytes = q.audioHash ? await read(String(q.audioHash)) : null;
  if (!bytes) throw new PullError("the audio is no longer stored", 410);
  return { bytes, mime: q.mime || "audio/mpeg", sha256: String(q.audioHash) };
}

/** The station says what happened to a clip. The first answer wins; a late "inserted" still counts for a clip that already expired. */
export async function ackQueueItem(db: HubDb, station: Doc, queueId: string, body: Doc, now: number): Promise<{ ok: true; already?: true }> {
  const status = ACK_STATUSES.find((s) => s === body?.status);
  if (!status) throw new PullError("status must be inserted, shadow, skipped or failed", 400);
  const { rows } = await db.query("select doc from hub_jit_queue where id = $1 and doc->>'stationId' = $2", [queueId, station.id]);
  const q = rows[0]?.doc as Doc | undefined;
  if (!q) throw new PullError("no such queue item", 404);

  const ack = { status, at: now, position: Number.isFinite(body.position) ? body.position : undefined, verified: typeof body.verified === "boolean" ? body.verified : null, replaced: typeof body.replaced === "boolean" ? body.replaced : null, reason: text(body.reason, 300) };
  const itemState = status === "inserted" ? "inserted" : status === "shadow" ? "shadow" : "fallback";
  const reason =
    status === "inserted" ? `inserted at position ${ack.position}${q.replace && ack.replaced === true ? `, replacing ${q.replace}` : ""}${ack.verified === false ? " (could not be read back)" : ""}`
    : status === "shadow" ? `the station is in shadow mode: ${ack.reason}`
    : `the station did not insert it (${status}): ${ack.reason || "no reason given"}`;

  const done = await db.query(
    `with won as (
       update hub_jit_queue set updated_at = now(), doc = jsonb_set(doc, '{state}', to_jsonb($3::text)) || jsonb_build_object('ack', $4::jsonb)
       where id = $1 and doc->>'stationId' = $2 and doc->>'state' in ('queued', 'expired')
       returning doc->>'itemId' as item_id),
     moved as (
       update hub_jit_items i set updated_at = now(), doc = jsonb_set(jsonb_set(jsonb_set(jsonb_set(i.doc, '{state}', to_jsonb($5::text)), '{reason}', to_jsonb($6::text)), '{updatedAt}', to_jsonb($7::bigint)),
         '{log}', coalesce(i.doc->'log', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('at', $7::bigint, 'step', $5::text, 'ok', $5::text <> 'fallback', 'detail', $6::text)))
       from won w where i.id = w.item_id and i.doc->>'state' in ('queued', 'fallback')
       returning i.id)
     select (select count(*) from won)::int as won`,
    [queueId, station.id, status, JSON.stringify(ack), itemState, reason, String(now)],
  );
  if (Number(done.rows[0]?.won) === 0) return { ok: true, already: true };
  await audit(db, station.id, "queue.ack", queueId, status, ack.reason, now);
  return { ok: true };
}
