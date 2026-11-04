-- Hub state in Postgres (Neon). One table per collection the hub keeps; each row is one record as JSON,
-- with its position so arrays keep their order. Anything else the hub stores lives in hub_state.
create table if not exists hub_stations        (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_playlists       (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_jobs            (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_audit           (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_jit_slots       (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_jit_items       (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_jit_queue       (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_alert_watches   (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_alert_log       (id text primary key, pos integer not null, doc jsonb not null, updated_at timestamptz not null default now());
create table if not exists hub_state           (key text primary key, doc jsonb not null, updated_at timestamptz not null default now());
