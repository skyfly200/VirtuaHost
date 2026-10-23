import { authorize } from "../auth.js";
import { createLogger } from "../log.js";
import { internalApi } from "../internal-api.js";
import { annotationsFor, TOOLS, ToolError } from "../mcp-tools.js";

const log = createLogger("mcp");

// A Model Context Protocol server over HTTP (Streamable HTTP, stateless, JSON responses), at POST /api/mcp, so an AI agent can manage
// stations through the same API the web UI uses. No SDK: it speaks the small part of JSON-RPC 2.0 that tool servers need
// (initialize, ping, tools/list, tools/call). Connect a client to https://<site>/api/mcp with `Authorization: Bearer <session token or
// access key>` (or `x-api-key`). The credential decides what the agent may do: a person's login acts as that person (their own clips,
// limits and role); ACCESS_KEY acts as an admin, so prefer a dedicated login for an agent. MCP_READ_ONLY=true offers only the read tools.
// Tools that reach the public stream or delete things need confirm=true, so a well-behaved agent has to ask first (lib/mcp-tools.ts).
// NOT verified against a live MCP client; the message shapes follow the MCP 2025-03-26 specification.
const SERVER = { name: "virtuahost", version: "1.0.0" };
const DEFAULT_VERSION = "2025-03-26";
const SUPPORTED = new Set(["2024-11-05", "2025-03-26", "2025-06-18"]);
const MAX_RESULT_CHARS = 60_000;

type Rpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
const reply = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

const readOnly = () => process.env.MCP_READ_ONLY === "true";
const offered = () => TOOLS.filter((t) => !readOnly() || t.kind === "read");

const INSTRUCTIONS = [
  "You manage radio stations through VirtuaHost: station profiles, AI-written and spoken drops (clips), schedules and the station queue.",
  "Tools marked destructive reach the PUBLIC STREAM or delete things: ask the person first and pass confirm=true only after they say yes.",
  "Prefer {{placeholders}} (see template_variables) over typing times, dates or weather into a script. Use estimate_cost before expensive steps, and find_place to set a station's location.",
].join(" ");

async function handleOne(msg: Rpc, req: Request): Promise<object | null> {
  const id = msg.id;
  const isNotification = msg.id === undefined;
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return isNotification ? null : fail(id, -32600, "not a JSON-RPC 2.0 request");

  switch (msg.method) {
    case "initialize": {
      const wanted = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : DEFAULT_VERSION;
      return reply(id, { protocolVersion: SUPPORTED.has(wanted) ? wanted : DEFAULT_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER, instructions: INSTRUCTIONS });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: offered().map((t) => ({ name: t.name, title: t.title, description: `${t.description}${t.kind === "air" ? " [PUBLIC STREAM or destructive: confirm with the person first]" : ""}`, inputSchema: t.inputSchema, annotations: annotationsFor(t.kind) })) });
    case "tools/call": {
      const tool = offered().find((t) => t.name === msg.params?.name);
      if (!tool) return fail(id, -32602, `unknown tool "${String(msg.params?.name).slice(0, 60)}"`);
      const args = (msg.params?.arguments && typeof msg.params.arguments === "object" ? msg.params.arguments : {}) as Record<string, unknown>;
      try {
        const out = await tool.run(args, internalApi(req));
        let text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n... (cut: ${text.length} characters; ask for less)`;
        log.info("tool", { tool: tool.name, kind: tool.kind });
        return reply(id, { content: [{ type: "text", text }] });
      } catch (err) {
        const message = err instanceof ToolError ? err.message : "the tool failed";
        if (!(err instanceof ToolError)) log.error("tool failed", { tool: tool.name, err });
        return reply(id, { isError: true, content: [{ type: "text", text: `Error: ${message}` }] });
      }
    }
    default:
      return isNotification || msg.method.startsWith("notifications/") ? null : fail(id, -32601, `method not found: ${msg.method}`);
  }
}

export async function handleMcp(req: Request): Promise<Response> {
  const { denied } = await authorize(req);
  if (denied) return denied;
  if (req.method !== "POST") return Response.json(fail(null, -32000, "use POST"), { status: 405, headers: { allow: "POST" } });

  const body = (await req.json().catch(() => undefined)) as Rpc | Rpc[] | undefined;
  if (body === undefined || body === null || typeof body !== "object") return Response.json(fail(null, -32700, "parse error: send JSON"), { status: 400 });

  if (Array.isArray(body)) {
    if (!body.length || body.length > 20) return Response.json(fail(null, -32600, "send 1 to 20 requests in a batch"), { status: 400 });
    const out = (await Promise.all(body.map((m) => handleOne(m, req)))).filter((r): r is object => r !== null);
    return out.length ? Response.json(out) : new Response(null, { status: 202 });
  }
  const out = await handleOne(body, req);
  return out ? Response.json(out) : new Response(null, { status: 202 });
}
