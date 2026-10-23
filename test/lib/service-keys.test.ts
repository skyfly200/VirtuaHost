import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../lib/gemini.js", () => ({ writeDjLine: vi.fn(async () => "Hello out there, night owls."), synthesizeSpeech: vi.fn(), DEFAULT_VOICE: "Kore" }));
vi.mock("../../lib/store.js", () => ({ saveClip: vi.fn(), listClips: vi.fn(async () => []) }));
vi.mock("../../lib/handoff.js", () => ({ handoffConfigured: vi.fn(() => false), handoffDefaults: vi.fn(), pushToStation: vi.fn() }));
vi.mock("../../lib/user-store.js", async (orig) => ({ ...(await orig<typeof import("../../lib/user-store.js")>()), getUser: vi.fn(async () => null) }));
vi.mock("../../lib/station-profile-store.js", () => ({ getStation: vi.fn(async () => null), listStations: vi.fn(async () => []), saveStation: vi.fn(), deleteStation: vi.fn(), newStationId: () => "x" }));
vi.mock("../../lib/persona-store.js", () => ({ listPersonas: vi.fn(async () => []), getPersona: vi.fn(async () => null), savePersona: vi.fn(), deletePersona: vi.fn(), newPersonaId: () => "p" }));

import { authorize, serviceKeys } from "../../lib/auth.js";
import { handleGenerate } from "../../lib/handlers/generate.js";
import { handleStations } from "../../lib/handlers/stations.js";
import { handlePersonas } from "../../lib/handlers/personas.js";
import { handleClips } from "../../lib/handlers/clips.js";

const SVC = "svc-key-0123456789abcdef";
const req = (method: string, path: string, key = SVC, body?: unknown) => new Request(`http://localhost${path}`, { method, headers: { "x-api-key": key, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeEach(() => {
  vi.stubEnv("ACCESS_KEY", "admin-key-0123456789abcdef");
  vi.stubEnv("GEMINI_API_KEY", "g"); vi.stubEnv("OPENROUTER_API_KEY", ""); vi.stubEnv("PROVIDER", ""); vi.stubEnv("AUTH_DISABLED", "");
  vi.stubEnv("SERVICE_KEYS", `glr-hub@rocky:generate+stations.read+personas.read:${SVC}, bad:nothing:short , nokey:generate:`);
});
afterEach(() => vi.unstubAllEnvs());

describe("scoped service keys", () => {
  it("parses entries, ignores malformed ones and never widens them", () => {
    expect(serviceKeys()).toEqual([{ name: "glr-hub", runAs: "rocky", scopes: ["generate", "stations.read", "personas.read"], key: SVC }]);
    expect(serviceKeys({ SERVICE_KEYS: `x:generate+admin+evil:${SVC}` } as never)[0].scopes).toEqual(["generate"]);
    expect(serviceKeys({ SERVICE_KEYS: `x:admin:${SVC}` } as never)).toEqual([]);
  });

  it("acts as the user it runs as, and is not an admin", async () => {
    const a = await authorize(req("POST", "/api/generate"), { scope: "generate" });
    expect(a.who).toMatchObject({ username: "rocky", role: "user", via: "service" });
  });

  it("opens only the routes that name its scopes", async () => {
    expect((await handleGenerate(req("POST", "/api/generate", SVC, { mode: "ai", prompt: "time check", textOnly: true }))).status).toBe(200);
    expect((await handleStations(req("GET", "/api/stations"), undefined, undefined)).status).toBe(200);
    expect((await handlePersonas(req("GET", "/api/personas"), undefined)).status).toBe(200);
  });

  it("is refused everywhere else: writes, admin routes, clips, other scopes", async () => {
    expect((await handleStations(req("POST", "/api/stations", SVC, { name: "x" }), undefined, undefined)).status).toBe(403);
    expect((await handleStations(req("DELETE", "/api/stations/x"), "x", undefined)).status).toBe(403);
    expect((await handlePersonas(req("POST", "/api/personas", SVC, { name: "x", instructions: "y" }), undefined)).status).toBe(403);
    expect((await handleClips(req("GET", "/api/clips"), undefined)).status).toBe(403);
    vi.stubEnv("SERVICE_KEYS", `only-read:stations.read:${SVC}`);
    expect((await handleGenerate(req("POST", "/api/generate", SVC, { mode: "ai", prompt: "x", textOnly: true }))).status).toBe(403);
  });

  it("a wrong key is still a plain 401, and the admin key still works", async () => {
    expect((await handleGenerate(req("POST", "/api/generate", "nope-nope-nope-nope-nope"))).status).toBe(401);
    expect((await handleStations(req("POST", "/api/stations", "admin-key-0123456789abcdef", { name: "x" }), undefined, undefined)).status).toBe(201);
  });

  it("works on its own when it is the only credential configured", async () => {
    vi.stubEnv("ACCESS_KEY", "");
    expect((await handleStations(req("GET", "/api/stations"), undefined, undefined)).status).toBe(200);
  });
});
