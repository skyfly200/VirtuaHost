import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handoffConfigured, handoffDefaults, pushToStation } from "../../lib/handoff.js";

const WAV = Buffer.from("RIFF....WAVEdata");
const OPTIONS = { title: "Doors open at six", text: "Doors open at six! Café & cheers", play: true, preempt: false };

function stationReply(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

describe("handoff", () => {
  beforeEach(() => {
    vi.stubEnv("STATION_URL", "https://radio.example.com/");
    vi.stubEnv("STATION_INGEST_TOKEN", "ing-secret");
    vi.stubEnv("STATION_AUTOPLAY", "");
    vi.stubEnv("STATION_PREEMPT", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("is only configured when both the URL and token are set", () => {
    expect(handoffConfigured()).toBe(true);
    vi.stubEnv("STATION_INGEST_TOKEN", "");
    expect(handoffConfigured()).toBe(false);
  });

  it("reads the autoplay and preempt defaults from the environment", () => {
    expect(handoffDefaults()).toEqual({ play: false, preempt: false, fx: undefined });
    vi.stubEnv("STATION_AUTOPLAY", "true");
    vi.stubEnv("STATION_PREEMPT", "true");
    expect(handoffDefaults()).toEqual({ play: true, preempt: true, fx: undefined });
  });

  it("posts the WAV to /ingest with the token, play flag and percent-encoded title and text", async () => {
    const fetchMock = stationReply(201, { clip: { id: "abc123" }, played: true });
    vi.stubGlobal("fetch", fetchMock);

    const result = await pushToStation(WAV, OPTIONS);

    expect(result).toEqual({ sent: true, clipId: "abc123", played: true, reason: undefined });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://radio.example.com/ingest?source=virtuahost&play=true");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer ing-secret");
    expect(init.headers["Content-Type"]).toBe("audio/wav");
    expect(decodeURIComponent(init.headers["X-Text"])).toBe("Doors open at six! Café & cheers");
    expect(init.headers["X-Text"]).not.toMatch(/[^\x20-\x7e]/); // header values stay plain ASCII
    expect(Buffer.from(init.body)).toEqual(WAV);
  });

  it("only asks to interrupt a live DJ when the clip is also being played", async () => {
    const fetchMock = stationReply(201, { clip: { id: "x" }, played: true });
    vi.stubGlobal("fetch", fetchMock);

    await pushToStation(WAV, { ...OPTIONS, play: true, preempt: true });
    expect(fetchMock.mock.calls[0][0]).toContain("play=true&preempt=true");

    await pushToStation(WAV, { ...OPTIONS, play: false, preempt: true });
    expect(fetchMock.mock.calls[1][0]).toBe("https://radio.example.com/ingest?source=virtuahost");
  });

  it("passes an effect preset and voice-changer settings to the station as query parameters", async () => {
    const fetchMock = stationReply(201, { clip: { id: "x" } });
    vi.stubGlobal("fetch", fetchMock);

    await pushToStation(WAV, { ...OPTIONS, play: false, fx: "underground" });
    expect(fetchMock.mock.calls[0][0]).toBe("https://radio.example.com/ingest?source=virtuahost&fx=underground");

    await pushToStation(WAV, { ...OPTIONS, play: false, fx: { preset: "robot", pitch: -3, speed: 1.1, tighten: true } });
    expect(fetchMock.mock.calls[1][0]).toBe("https://radio.example.com/ingest?source=virtuahost&fx=robot&pitch=-3&speed=1.1&tighten=true");

    await pushToStation(WAV, { ...OPTIONS, play: false, fx: { pitch: 2 } });
    expect(fetchMock.mock.calls[2][0]).toBe("https://radio.example.com/ingest?source=virtuahost&pitch=2");
  });

  it("reads the station-wide effect from STATION_FX", () => {
    expect(handoffDefaults().fx).toBeUndefined();
    vi.stubEnv("STATION_FX", "underground");
    expect(handoffDefaults().fx).toBe("underground");
  });

  it("reports when the station skipped playback because a live DJ is on air", async () => {
    vi.stubGlobal("fetch", stationReply(201, { clip: { id: "x" }, played: false, reason: "live DJ on air" }));
    const result = await pushToStation(WAV, OPTIONS);
    expect(result).toMatchObject({ sent: true, played: false, reason: "live DJ on air" });
  });

  it("returns the station's error message instead of throwing", async () => {
    vi.stubGlobal("fetch", stationReply(401, { error: "login required" }));
    expect(await pushToStation(WAV, OPTIONS)).toEqual({ sent: false, error: "login required" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>bad gateway</html>", { status: 502 })));
    expect(await pushToStation(WAV, OPTIONS)).toEqual({ sent: false, error: "station returned 502" });
  });

  it("returns an error when the station cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    const result = await pushToStation(WAV, OPTIONS);
    expect(result.sent).toBe(false);
    expect(result.error).toContain("could not reach the station");
  });

  it("refuses to send the token over plain http to a remote host, but allows localhost", async () => {
    const fetchMock = stationReply(201, { clip: { id: "x" } });
    vi.stubGlobal("fetch", fetchMock);

    vi.stubEnv("STATION_URL", "http://radio.example.com");
    expect(await pushToStation(WAV, OPTIONS)).toEqual({ sent: false, error: "STATION_URL must use https" });
    vi.stubEnv("STATION_URL", "not a url");
    expect((await pushToStation(WAV, OPTIONS)).error).toBe("STATION_URL is not a valid URL");
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("STATION_URL", "http://localhost:3000");
    expect((await pushToStation(WAV, OPTIONS)).sent).toBe(true);
  });

  it("does nothing without configuration", async () => {
    vi.stubEnv("STATION_URL", "");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await pushToStation(WAV, OPTIONS)).sent).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
