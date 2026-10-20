import test from "node:test";
import assert from "node:assert/strict";
import { createHostLoop, icecastReaders, parseNowPlaying } from "../host.mjs";

const CONFIG = { enabled: true, every: 1, minGapSeconds: 0, skipArtists: ["", "jingle radio"], preempt: false };

function rig({ config = CONFIG, live = false, linkFails = false } = {}) {
  const calls = []; const delivered = []; const statuses = [];
  let track = { artist: "A", title: "One" }; let isLive = live; let clock = 1_700_000_000_000;
  const api = async (path, body) => {
    calls.push([path, body]);
    if (path === "/api/station/host") return { config };
    if (path === "/api/station/host/link") { if (linkFails) throw new Error("site returned 502"); return { clipId: `clip-${body.title}`, text: `That was ${body.title}`, source: "template", audioUrl: `/api/station/clips/clip-${body.title}`, preempt: false }; }
    if (path === "/api/station/host/status") { statuses.push(body); return { ok: true }; }
  };
  const loop = createHostLoop({ api, nowPlaying: async () => track, isLive: async () => isLive, deliver: async (item) => { delivered.push(item); }, now: () => clock, log: () => {} });
  return { loop, calls, delivered, statuses, play: (t) => { track = t; clock += 60_000; }, setLive: (v) => { isLive = v; } };
}

test("parses Icecast titles", () => {
  assert.deepEqual(parseNowPlaying({ title: "Ada - Song - Remix" }), { artist: "Ada", title: "Song - Remix" });
  assert.deepEqual(parseNowPlaying({ artist: "Ada", title: "Song" }), { artist: "Ada", title: "Song" });
  assert.deepEqual(parseNowPlaying(undefined), { artist: "", title: "" });
});

test("prepares a link for each track and plays it when the next track begins", async () => {
  const r = rig();
  await r.loop.tick();                                   // track One starts: link prepared, nothing to play yet
  assert.equal(r.delivered.length, 0);
  assert.deepEqual(r.calls.filter(([p]) => p.endsWith("/link")).map(([, b]) => b), [{ artist: "A", title: "One" }]);
  r.play({ artist: "B", title: "Two" });
  await r.loop.tick();                                   // Two starts: the link about One is said, a new one is prepared
  assert.equal(r.delivered.length, 1);
  assert.equal(r.delivered[0].title, "That was One");
  assert.equal(r.delivered[0].play, true);
  assert.equal(r.loop.state.ready.title, "Two");
  assert.equal(r.loop.state.counters.played, 1);
});

test("stays quiet over spots, while live, and inside the minimum gap", async () => {
  const r = rig({ config: { ...CONFIG, minGapSeconds: 3600 } });
  await r.loop.tick();
  r.play({ artist: "B", title: "Two" }); await r.loop.tick();      // plays (no link yet, so gap passes)
  r.play({ artist: "C", title: "Three" }); await r.loop.tick();    // inside the gap: skipped
  assert.equal(r.delivered.length, 1);
  assert.equal(r.loop.state.counters.skipped, 1);

  const s = rig();
  await s.loop.tick();
  s.play({ artist: "Jingle Radio", title: "Spot" }); await s.loop.tick();   // never over or about a spot
  assert.equal(s.delivered.length, 0);
  assert.equal(s.calls.filter(([p]) => p.endsWith("/link")).length, 1);

  const l = rig();
  await l.loop.tick();
  l.setLive(true); l.play({ artist: "B", title: "Two" }); await l.loop.tick();  // a live DJ: nothing said, nothing prepared
  assert.equal(l.delivered.length, 0);
  assert.equal(l.calls.filter(([p]) => p.endsWith("/link")).length, 1);
});

test("does nothing while switched off, and survives a failing site", async () => {
  const off = rig({ config: { ...CONFIG, enabled: false } });
  assert.equal(await off.loop.tick(), "off");
  assert.equal(off.calls.filter(([p]) => p.endsWith("/link")).length, 0);

  const bad = rig({ linkFails: true });
  await bad.loop.tick();
  assert.equal(bad.loop.state.counters.failed, 1);
  assert.match(bad.loop.state.error, /could not prepare a link/);
  bad.play({ artist: "B", title: "Two" });
  assert.equal(await bad.loop.tick(), "changed");          // keeps going
});

test("reports its status to the site", async () => {
  const r = rig();
  await r.loop.tick();
  assert.equal(r.statuses.at(-1).current.title, "One");
  assert.equal(r.statuses.at(-1).ready.text, "That was One");
});

test("reads Icecast's status file", async () => {
  const status = { icestats: { source: [{ listenurl: "http://x:8000/live", title: "DJ set" }, { listenurl: "http://x:8000/stream", title: "Ada - Song" }] } };
  const readers = icecastReaders({ url: "http://x/status", fetchImpl: async () => ({ ok: true, json: async () => status }) });
  assert.deepEqual(await readers.nowPlaying(), { artist: "Ada", title: "Song" });
  assert.equal(await readers.isLive(), true);
  const single = icecastReaders({ url: "http://x/status", fetchImpl: async () => ({ ok: true, json: async () => ({ icestats: { source: { listenurl: "http://x:8000/stream", title: "Solo" } } }) }) });
  assert.equal(await single.isLive(), false);
  assert.deepEqual(await single.nowPlaying(), { artist: "", title: "Solo" });
});

test("a station's loop reads and reports its own host settings", async () => {
  const paths = [];
  const loop = createHostLoop({
    api: async (path) => { paths.push(path); if (path.startsWith("/api/station/host?")) return { config: { enabled: true, every: 1, minGapSeconds: 0, skipArtists: [], preempt: false } }; if (path.includes("/link")) return { clipId: "c", text: "hi", source: "template", audioUrl: "/a", preempt: false }; return { ok: true }; },
    nowPlaying: async () => ({ artist: "A", title: "One" }), isLive: async () => false, deliver: async () => {}, log: () => {}, stationId: "krap-1a2b",
  });
  await loop.tick();
  assert.ok(paths.length >= 3);
  assert.ok(paths.every((p) => p.endsWith("?station=krap-1a2b")), paths.join(" "));
  assert.deepEqual([...new Set(paths.map((p) => p.split("?")[0]))].sort(), ["/api/station/host", "/api/station/host/link", "/api/station/host/status"]);
});
