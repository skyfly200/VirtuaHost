import { handleAlerts } from "./handlers/alerts.js";
import { handleClips } from "./handlers/clips.js";
import { handleCoverage } from "./handlers/coverage.js";
import { handleEstimate } from "./handlers/estimate.js";
import { handleGenerate } from "./handlers/generate.js";
import { handleOptions } from "./handlers/options.js";
import { handleProxy } from "./handlers/proxy.js";
import { handlePersonas } from "./handlers/personas.js";
import { handlePlaces } from "./handlers/places.js";
import { handleQueue } from "./handlers/queue.js";
import { handleSchedules } from "./handlers/schedules.js";
import { handleStations } from "./handlers/stations.js";
import { handleTemplate } from "./handlers/template.js";
import { handleUsers } from "./handlers/users.js";

// Calls the site's own API in-process, as the caller who made the outer request (their credential is forwarded, so every sign-in, role,
// ownership and quota rule applies exactly as if they had called /api/* themselves). Used by the MCP endpoint (lib/handlers/mcp.ts).
type Route = (req: Request, rest: string[]) => Promise<Response>;
const ROUTES: Record<string, Route> = {
  alerts: (req) => handleAlerts(req),
  clips: (req, r) => handleClips(req, r[0]),
  coverage: (req) => handleCoverage(req),
  estimate: (req) => handleEstimate(req),
  generate: (req) => handleGenerate(req),
  hub: (req) => handleProxy(req),
  options: (req) => handleOptions(req),
  personas: (req, r) => handlePersonas(req, r[0]),
  places: (req) => handlePlaces(req),
  queue: (req, r) => handleQueue(req, r[0]),
  schedules: (req, r) => handleSchedules(req, r[0], r[1]),
  stations: (req, r) => handleStations(req, r[0], r[1]),
  template: (req) => handleTemplate(req),
  users: (req, r) => handleUsers(req, r[0]),
};

export interface ApiResult { status: number; ok: boolean; body: unknown }
export type ApiCall = (method: string, path: string, opts?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown }) => Promise<ApiResult>;

export function internalApi(outer: Request): ApiCall {
  const origin = new URL(outer.url).origin;
  const auth: Record<string, string> = {};
  for (const h of ["authorization", "x-api-key"]) { const v = outer.headers.get(h); if (v) auth[h] = v; }

  return async (method, path, opts = {}) => {
    const url = new URL(path, origin);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
    const route = ROUTES[parts[0]];
    if (!route) return { status: 404, ok: false, body: { error: `no such API: ${url.pathname}` } };
    const req = new Request(url, { method, headers: { ...auth, ...(opts.body !== undefined ? { "content-type": "application/json" } : {}) }, ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}) });
    const res = await route(req, parts.slice(1).map(decodeURIComponent));
    const text = await res.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, body };
  };
}
