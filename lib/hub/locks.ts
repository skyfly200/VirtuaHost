import type { HubDb } from "./db.js";

// A named lock with an expiry. acquire() is one statement: it inserts the lock, or takes it over only if the old one has expired, so of
// two callers at the same moment exactly one gets it. The one-minute tick and a slot's background run use this so they never overlap.

/** True when this caller now holds the lock for `ttlMs`. */
export async function acquireLock(db: HubDb, name: string, owner: string, ttlMs: number): Promise<boolean> {
  const { rows } = await db.query(
    `insert into hub_locks (name, owner, expires_at) values ($1, $2, now() + ($3 || ' milliseconds')::interval)
     on conflict (name) do update set owner = excluded.owner, expires_at = excluded.expires_at where hub_locks.expires_at < now()
     returning owner`,
    [name, owner, String(Math.max(1, Math.floor(ttlMs)))],
  );
  return rows.length === 1 && rows[0].owner === owner;
}

/** Gives the lock up early. Only the holder can; a lock that has moved on to someone else is left alone. */
export async function releaseLock(db: HubDb, name: string, owner: string): Promise<void> {
  await db.query("delete from hub_locks where name = $1 and owner = $2", [name, owner]);
}
