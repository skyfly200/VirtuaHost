-- Named locks with an expiry, so only one function run works on a thing (a tick, a slot) at a time.
create table if not exists hub_locks (name text primary key, owner text not null, expires_at timestamptz not null);
