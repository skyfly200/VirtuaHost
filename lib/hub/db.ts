import { neon } from "@neondatabase/serverless";

// The hub's database (Neon Postgres, DATABASE_URL). The tables are in chips-voice/hub/migrations/. Everything the site does with them is
// one statement per call (conditional UPDATE ... RETURNING and similar), so this only needs query(): there are no multi-step transactions
// to hold open across serverless calls.
export interface HubDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

let override: HubDb | null = null;
let cached: { url: string; db: HubDb } | null = null;

/** Tests (and anything with its own connection) install a database here; null puts the environment's back. */
export function setHubDb(db: HubDb | null): void {
  override = db;
}

export function hubDbConfigured(): boolean {
  return Boolean(override || process.env.DATABASE_URL);
}

export function hubDb(): HubDb | null {
  if (override) return override;
  const url = process.env.DATABASE_URL ?? "";
  if (!url) return null;
  if (cached?.url === url) return cached.db;
  const sql = neon(url);
  const db: HubDb = {
    query: async (text, params = []) => {
      const out = (await sql.query(text, params)) as unknown;
      return { rows: (Array.isArray(out) ? out : (out as { rows: Record<string, unknown>[] }).rows) as Record<string, unknown>[] };
    },
  };
  cached = { url, db };
  return db;
}
