import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../lib/log.js";

describe("log", () => {
  let out: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    delete process.env.LOG_LEVEL;
    out = vi.spyOn(console, "log").mockImplementation(() => {});
    err = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it("writes one JSON line with scope, level and fields", () => {
    createLogger("t", { requestId: "r1" }).info("hello", { n: 2 });
    const line = JSON.parse(out.mock.calls[0][0] as string);
    expect(line).toMatchObject({ level: "info", scope: "t", msg: "hello", n: 2, requestId: "r1" });
    expect(typeof line.time).toBe("string");
  });

  it("serializes errors passed as err and sends them to stderr", () => {
    createLogger("t").error("boom", { err: new Error("bad thing") });
    const line = JSON.parse(err.mock.calls[0][0] as string);
    expect(line).toMatchObject({ level: "error", error: "bad thing", errorName: "Error" });
    expect(line.stack).toContain("bad thing");
  });

  it("redacts secret-looking fields", () => {
    createLogger("t").info("x", { apiKey: "abc", token: "def", ok: 1 });
    const line = JSON.parse(out.mock.calls[0][0] as string);
    expect(line).toMatchObject({ apiKey: "[redacted]", token: "[redacted]", ok: 1 });
  });

  it("respects LOG_LEVEL", () => {
    process.env.LOG_LEVEL = "warn";
    const log = createLogger("t");
    log.info("quiet");
    log.debug("quiet");
    expect(out).not.toHaveBeenCalled();
    process.env.LOG_LEVEL = "silent";
    log.error("quiet");
    expect(err).not.toHaveBeenCalled();
  });

  it("child loggers carry extra fields", () => {
    createLogger("t").child({ clipId: "c1" }).info("x");
    expect(JSON.parse(out.mock.calls[0][0] as string).clipId).toBe("c1");
  });
});
