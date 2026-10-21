// Structured logging: one JSON object per line on stdout/stderr, which Netlify's function logs
// (and any log drain) can filter by field. Set LOG_LEVEL to debug | info | warn | error | silent
// (default info). Never pass secrets, tokens or full request bodies as fields.

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const RANK: Record<Level | "silent", number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

// Field names whose values are never written out.
const SECRET = /key|token|secret|password|authorization|cookie/i;

function threshold(): number {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase() as Level | "silent";
  return RANK[raw] ?? RANK.info;
}

export function errorFields(err: unknown): Fields {
  if (err instanceof Error) {
    return { error: err.message, errorName: err.name, stack: err.stack?.split("\n").slice(0, 6).join("\n") };
  }
  return { error: String(err) };
}

function clean(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = SECRET.test(k) ? "[redacted]" : v instanceof Error ? errorFields(v) : v;
  }
  return out;
}

function emit(level: Level, scope: string, msg: string, fields: Fields = {}): void {
  if (RANK[level] < threshold()) return;
  const line = JSON.stringify({ time: new Date().toISOString(), level, scope, msg, ...clean(fields) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  /** Pass the caught error as `err` and it is logged with its name and a short stack. */
  error(msg: string, fields?: Fields & { err?: unknown }): void;
  child(more: Fields): Logger;
}

/** A logger tagged with a scope (e.g. "generate") and any fixed fields such as a request id. */
export function createLogger(scope: string, base: Fields = {}): Logger {
  const withBase = (f: Fields = {}) => ({ ...base, ...f });
  return {
    debug: (msg, f) => emit("debug", scope, msg, withBase(f)),
    info: (msg, f) => emit("info", scope, msg, withBase(f)),
    warn: (msg, f) => emit("warn", scope, msg, withBase(f)),
    error: (msg, f) => {
      const { err, ...rest } = f ?? {};
      emit("error", scope, msg, withBase({ ...rest, ...(err === undefined ? {} : errorFields(err)) }));
    },
    child: (more) => createLogger(scope, withBase(more)),
  };
}
