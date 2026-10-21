import type { ApiCall } from "./internal-api.js";

// The tools an AI agent (Claude, Sylvia's assistant, any MCP client) gets for running stations through VirtuaHost. Every tool calls the
// site's own API as the caller, so sign-in, roles, ownership and limits are enforced by the same code as the web UI.
//
// Three kinds, marked in the annotations and in the descriptions:
//   read       looks only (always safe)
//   write      changes the site (saves a station, a clip, a schedule) but nothing reaches listeners
//   air        PUBLIC STREAM: puts audio in front of listeners; also destructive actions. These need `confirm: true`, so an agent has to
//              stop and ask the person first. MCP_READ_ONLY=true registers only the read tools.
export type Kind = "read" | "write" | "air";
type Schema = { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
export interface Tool {
  name: string;
  title: string;
  description: string;
  kind: Kind;
  inputSchema: Schema;
  run: (args: Record<string, unknown>, api: ApiCall) => Promise<unknown>;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Schema => ({ type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const CONFIRM = bool("Must be true. Set it only after the person has said yes to exactly this action.");

export class ToolError extends Error {}
// A failed API call becomes a plain message the agent can act on (including what to fix).
const ok = (res: { ok: boolean; status: number; body: unknown }): unknown => {
  if (res.ok) return res.body;
  const message = res.body && typeof res.body === "object" && "error" in res.body ? String((res.body as { error: unknown }).error) : `the API answered ${res.status}`;
  throw new ToolError(`${message} (${res.status})`);
};
const pick = (args: Record<string, unknown>, keys: string[]) => Object.fromEntries(keys.filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
const need = (args: Record<string, unknown>, key: string): string => {
  if (typeof args[key] !== "string" || !args[key]) throw new ToolError(`${key} is required`);
  return args[key] as string;
};

const STATION_FIELDS = ["name", "callsign", "frequency", "tagline", "description", "emoji", "color", "genres", "city", "tz", "website", "streamUrl", "contact", "defaultPersonaId", "defaultFx", "defaultSpeechModel", "defaultTextModel", "defaultVoice", "skipArtists", "lat", "lon", "tempUnit", "variables", "place", "coverageKm", "textModels", "speechModels", "autoplay", "preempt", "notes"];

export const TOOLS: Tool[] = [
  // ---------- read ----------
  { name: "whoami", title: "Who am I", kind: "read", description: "Who you are signed in as, your role (admin or user) and your limits and usage.", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/users/me")) },
  { name: "list_stations", title: "List stations", kind: "read", description: "All station profiles (name, call sign, time zone, location, defaults). Pass lat and lon to also rank them by distance from a point and see whether each station's coverage circle contains it (for choosing which stations an event is relevant to).", inputSchema: obj({ lat: num("latitude of an event or place"), lon: num("longitude") }),
    run: async (a, api) => ok(await api("GET", "/api/stations", { query: typeof a.lat === "number" && typeof a.lon === "number" ? { near: `${a.lat},${a.lon}` } : {} })) },
  { name: "station_summary", title: "Station summary", kind: "read", description: "What the site holds for one station: clips, promos, schedules (and the next run), items waiting for its daemon, and when its virtual host last reported.", inputSchema: obj({ station: str("station id") }, ["station"]),
    run: async (a, api) => ok(await api("GET", `/api/stations/${encodeURIComponent(need(a, "station"))}/summary`)) },
  { name: "find_place", title: "Find a place", kind: "read", description: "Look up a town or city by name (for example \"Houston, TX\"): coordinates, state, country and time zone. Use the result to set a station's location.", inputSchema: obj({ query: str("town or city, optionally with state or country") }, ["query"]),
    run: async (a, api) => ok(await api("GET", "/api/places", { query: { q: need(a, "query") } })) },
  { name: "active_alerts", title: "Active weather alerts", kind: "read", description: "US National Weather Service alerts active at a station's location (the station needs a location). This is a read of NWS data, not the Emergency Alert System.", inputSchema: obj({ station: str("station id"), min: { type: "string", enum: ["Unknown", "Minor", "Moderate", "Severe", "Extreme"], description: "minimum severity (default Moderate)" } }, ["station"]),
    run: async (a, api) => ok(await api("GET", "/api/alerts", { query: { station: need(a, "station"), min: typeof a.min === "string" ? a.min : undefined } })) },
  { name: "list_personas", title: "List DJ personas", kind: "read", description: "The DJ personas (characters) you can use: name, voice, tone, models.", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/personas")) },
  { name: "list_models", title: "List models and formats", kind: "read", description: "The writing and speech models that can be chosen (with price tier and whether each filters strong language), tones and drop formats, for a station (the station may limit the models).", inputSchema: obj({ station: str("station id") }),
    run: async (a, api) => ok(await api("GET", "/api/options", { query: { station: typeof a.station === "string" ? a.station : undefined } })) },
  { name: "list_clips", title: "List clips", kind: "read", description: "Saved clips, newest first (you see your own plus the station's shared ones).", inputSchema: obj({ limit: num("how many to return (default 30, max 100)") }),
    run: async (a, api) => { const out = ok(await api("GET", "/api/clips")) as { clips: unknown[] }; return { clips: out.clips.slice(0, Math.min(100, Math.max(1, Number(a.limit) || 30))), total: out.clips.length }; } },
  { name: "clip_info", title: "Clip details", kind: "read", description: "The details kept with one clip: script, voice, models, tags, expiry.", inputSchema: obj({ clipId: str("clip id") }, ["clipId"]), run: async (a, api) => ok(await api("GET", `/api/clips/${encodeURIComponent(need(a, "clipId"))}/meta`)) },
  { name: "list_schedules", title: "List schedules", kind: "read", description: "Schedules: what runs when, whether it is on, the next run and the last result.", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/schedules")) },
  { name: "list_queue", title: "List the station queue", kind: "read", description: "Clips waiting to be collected by a station daemon (and recent ones).", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/queue")) },
  { name: "template_variables", title: "Placeholders for drops", kind: "read", description: "The {{placeholders}} (time, weather, alert, DJ, station, length, ...) a drop can use for a station and persona, with today's real values. Use them instead of typing times or temperatures into a script.", inputSchema: obj({ station: str("station id"), persona: str("persona id"), seconds: num("target length in seconds") }),
    run: async (a, api) => ok(await api("GET", "/api/template", { query: pick(a, ["station", "persona", "seconds"]) as Record<string, string> })) },
  { name: "render_template", title: "Try a template", kind: "read", description: "Fill in the {{placeholders}} of a text with today's values and show the result (and any placeholder with no value). Nothing is spoken or saved.", inputSchema: obj({ text: str("text with {{placeholders}}"), station: str("station id"), persona: str("persona id"), seconds: num("target length") }, ["text"]),
    run: async (a, api) => ok(await api("POST", "/api/template", { body: pick(a, ["text", "station", "persona", "seconds"]) })) },
  { name: "estimate_cost", title: "Estimate cost", kind: "read", description: "What a step would use before you spend it: tokens, dollars where a price is known, and a warning for premium, unpriced or much dearer models. kind is write, speak, flier-read or flier-promo.", inputSchema: obj({ kind: { type: "string", enum: ["write", "speak", "flier-read", "flier-promo"] }, prompt: str("for write: the brief"), text: str("for speak: the text"), textModel: str("writing model"), speechModel: str("speech model"), station: str("station id"), persona: str("persona id"), seconds: num("target length"), explicit: bool("strong language wanted") }, ["kind"]),
    run: async (a, api) => ok(await api("POST", "/api/estimate", { body: a })) },

  // ---------- the hub (several live stations; admins; needs HUB_URL and HUB_KEY on the site) ----------
  { name: "hub_stations", title: "Hub: live stations", kind: "read", description: "The live stations the hub controls (Chips Voice servers and RadioDJ machines): online or not, what is playing, what each can do. Needs the site connected to the hub (admins).", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/hub/stations")) },
  { name: "hub_alerts", title: "Hub: weather alert watches", kind: "read", description: "The hub's US weather-alert watches (where it listens, minimum severity, whether it only notes alerts or broadcasts them) and what it has recently handled.", inputSchema: obj({}), run: async (_a, api) => ok(await api("GET", "/api/hub/alerts")) },
  { name: "hub_alert_check", title: "Hub: check alerts now (dry run)", kind: "read", description: "Ask the hub to check its watches against the National Weather Service now WITHOUT recording or airing anything: shows what it would handle.", inputSchema: obj({}), run: async (_a, api) => ok(await api("POST", "/api/hub/alerts/check", { query: { dry: "1" }, body: {} })) },
  { name: "hub_set_alert_watch", title: "Hub: add a weather alert watch", kind: "write", description: "Add a watch: where to listen (lat and lon, a state like TX, or a zone like TXZ213), the minimum severity, optional event names, and the action. action notify only records alerts (the default); action broadcast speaks them and plays them on the chosen stations, so it needs confirm=true.", inputSchema: obj({ name: str("a name"), lat: num("latitude"), lon: num("longitude"), area: str("two-letter state"), zone: str("NWS zone"), minSeverity: { type: "string", enum: ["Unknown", "Minor", "Moderate", "Severe", "Extreme"] }, events: { type: "array", items: { type: "string" }, description: "only these alert types, e.g. Tornado Warning" }, action: { type: "string", enum: ["notify", "broadcast"] }, stations: { type: "array", items: { type: "string" }, description: "hub station ids for broadcast (default all)" }, preempt: bool("cut in over a live DJ"), confirm: CONFIRM }, ["name"]),
    run: async (a, api) => {
      if (a.action === "broadcast" && a.confirm !== true) throw new ToolError("action=broadcast will put weather alerts on the PUBLIC STREAM automatically. Ask the person, then call again with confirm=true.");
      const body = { ...a };
      delete body.confirm;
      return ok(await api("POST", "/api/hub/alerts/watches", { body }));
    } },

  // ---------- write (nothing reaches listeners) ----------
  { name: "create_station", title: "Create a station", kind: "write", description: "Create a station profile (admins only). Nothing needs a server: it is data. Set its location with find_place first so weather, alerts and nearness work.", inputSchema: obj(Object.fromEntries(STATION_FIELDS.map((f) => [f, {}])) as Record<string, unknown>, ["name"]),
    run: async (a, api) => ok(await api("POST", "/api/stations", { body: pick(a, STATION_FIELDS) })) },
  { name: "update_station", title: "Update a station", kind: "write", description: "Change a station profile (admins only). Send the whole profile you want kept: fields you leave out are cleared, so read it with list_stations first and send it back with your changes.", inputSchema: obj({ station: str("station id"), ...Object.fromEntries(STATION_FIELDS.map((f) => [f, {}])) }, ["station", "name"]),
    run: async (a, api) => ok(await api("PUT", `/api/stations/${encodeURIComponent(need(a, "station"))}`, { body: pick(a, STATION_FIELDS) })) },
  { name: "write_line", title: "Write a line (not spoken)", kind: "write", description: "Have the AI write a drop from a brief and return the text only: nothing is spoken or saved. The text may contain {{placeholders}} that are filled in when it is spoken. Costs an AI request.", inputSchema: obj({ prompt: str("the brief"), station: str("station id"), persona: str("persona id"), format: str("station-id, song-intro, back-announce, promo, time-check or shoutout"), tone: str("tone"), seconds: num("target length"), explicit: bool("allow strong language"), textModel: str("writing model") }, ["prompt"]),
    run: async (a, api) => ok(await api("POST", "/api/generate", { body: { mode: "ai", textOnly: true, ...pick(a, ["prompt", "station", "persona", "format", "tone", "seconds", "explicit", "textModel"]) } })) },
  { name: "make_clip", title: "Make and save a clip", kind: "write", description: "Speak a text (placeholders filled in first) and SAVE it as a clip in the library. It is NOT sent to the station: use send_clip_to_station for that. mode say speaks the text as given; mode ai writes the line from the text as a brief first. Costs an AI request.", inputSchema: obj({ mode: { type: "string", enum: ["say", "ai"] }, text: str("for say: what to say"), prompt: str("for ai: the brief"), station: str("station id"), persona: str("persona id"), voice: str("voice name or id"), speechModel: str("speech model"), textModel: str("writing model"), tone: str("tone"), seconds: num("target length"), explicit: bool("allow strong language") }, ["mode"]),
    run: async (a, api) => ok(await api("POST", "/api/generate", { body: { handoff: false, ...pick(a, ["mode", "text", "prompt", "station", "persona", "voice", "speechModel", "textModel", "tone", "seconds", "explicit"]) } })) },
  { name: "create_schedule", title: "Create a schedule", kind: "write", description: "Schedule a drop: once, every N minutes, or daily at a local time. Each run makes the clip fresh (placeholders filled in at that moment). Set send to none (just save), library or air. send air puts it on the PUBLIC STREAM on a timetable, so confirm with the person first (confirm must be true when send is air). See list_schedules for the shape of existing ones.", inputSchema: obj({ name: str("a name"), when: { type: "object", description: "{ type: 'once', at } | { type: 'interval', everyMinutes } | { type: 'daily', time: 'HH:MM', tz, days?: [0-6] }" }, content: { type: "object", description: "{ kind: 'text', text } | { kind: 'ai', prompt } | { kind: 'clip', clipId }" }, send: { type: "string", enum: ["none", "library", "air"] }, personaId: str("persona id"), stationId: str("station id"), until: str("end date-time (ISO)"), confirm: CONFIRM }, ["name", "when", "content"]),
    run: async (a, api) => {
      if (a.send === "air" && a.confirm !== true) throw new ToolError("send=air schedules audio onto the PUBLIC STREAM. Ask the person, then call again with confirm=true.");
      const body = { ...a };
      delete body.confirm;
      return ok(await api("POST", "/api/schedules", { body }));
    } },
  { name: "set_schedule_enabled", title: "Turn a schedule on or off", kind: "write", description: "Turn a schedule on or off (turning one on that sends to air needs confirm).", inputSchema: obj({ scheduleId: str("schedule id"), enabled: bool("on or off"), confirm: CONFIRM }, ["scheduleId", "enabled"]),
    run: async (a, api) => {
      if (a.enabled === true && a.confirm !== true) throw new ToolError("Turning a schedule on can put audio on the PUBLIC STREAM. Ask the person, then call again with confirm=true.");
      return ok(await api("PUT", `/api/schedules/${encodeURIComponent(need(a, "scheduleId"))}`, { body: { enabled: a.enabled === true } }));
    } },

  // ---------- air / destructive (confirm required) ----------
  { name: "send_clip_to_station", title: "Send a clip to the station", kind: "air", description: "PUBLIC STREAM when play is true: queue a saved clip for the station daemon. play=true puts it on air as soon as the daemon collects it; play=false only adds it to the station's library. Ask the person first and set confirm=true.", inputSchema: obj({ clipId: str("clip id"), play: bool("put on air (true) or just add to the library (false)"), preempt: bool("cut in over a live DJ"), fx: str("audio treatment preset"), confirm: CONFIRM }, ["clipId", "play", "confirm"]),
    run: async (a, api) => {
      if (a.confirm !== true) throw new ToolError("This can put audio on the PUBLIC STREAM. Ask the person, then call again with confirm=true.");
      return ok(await api("POST", "/api/queue", { body: pick(a, ["clipId", "play", "preempt", "fx"]) }));
    } },
  { name: "run_schedule_now", title: "Run a schedule now", kind: "air", description: "Run a schedule immediately (makes the clip and sends it as the schedule says, which may be onto the PUBLIC STREAM). Costs an AI request. Ask the person first and set confirm=true.", inputSchema: obj({ scheduleId: str("schedule id"), confirm: CONFIRM }, ["scheduleId", "confirm"]),
    run: async (a, api) => {
      if (a.confirm !== true) throw new ToolError("This can put audio on the PUBLIC STREAM. Ask the person, then call again with confirm=true.");
      return ok(await api("POST", `/api/schedules/${encodeURIComponent(need(a, "scheduleId"))}/run`, { body: {} }));
    } },
  { name: "delete_clip", title: "Delete a clip", kind: "air", description: "Permanently delete a saved clip (schedules that use it will fail). Ask the person first and set confirm=true.", inputSchema: obj({ clipId: str("clip id"), confirm: CONFIRM }, ["clipId", "confirm"]),
    run: async (a, api) => {
      if (a.confirm !== true) throw new ToolError("Deleting is permanent. Ask the person, then call again with confirm=true.");
      return ok(await api("DELETE", `/api/clips/${encodeURIComponent(need(a, "clipId"))}`));
    } },
  { name: "delete_schedule", title: "Delete a schedule", kind: "air", description: "Permanently delete a schedule. Ask the person first and set confirm=true.", inputSchema: obj({ scheduleId: str("schedule id"), confirm: CONFIRM }, ["scheduleId", "confirm"]),
    run: async (a, api) => {
      if (a.confirm !== true) throw new ToolError("Deleting is permanent. Ask the person, then call again with confirm=true.");
      return ok(await api("DELETE", `/api/schedules/${encodeURIComponent(need(a, "scheduleId"))}`));
    } },
];

export const annotationsFor = (kind: Kind) => ({ readOnlyHint: kind === "read", destructiveHint: kind === "air", idempotentHint: kind === "read", openWorldHint: kind !== "read" });
