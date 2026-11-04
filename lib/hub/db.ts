import { neon } from "@neondatabase/serverless";

// The hub's database (Neon Postgres, DATABASE_URL). The tables are in chips-voice/hub/migrations/. The pull-station calls are one statement
// each (conditional UPDATE ... RETURNING and similar), so they only need query(). The just-in-time runs save their changes with batch(),
// several statements as one transaction (Neon's HTTP transaction: nothing is held open between calls).
export interface HubDb {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, any>[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  batch(statements: { text: string; params: unknown[] }[]): Promise<void>;
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
    batch: async (statements) => {
      if (statements.length) await sql.transaction((txn) => statements.map((s) => txn.query(s.text, s.params)));
    },
  };
  cached = { url, db };
  return db;
}
