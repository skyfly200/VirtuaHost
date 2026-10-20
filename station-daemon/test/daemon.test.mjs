import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createDaemon, liquidsoapCommand, annotateUri } from "../daemon.mjs";

// A site stand-in: a queue of items, the audio, and a record of acknowledgements.
function fakeSite(items) {
  const acks = [];
  const asked = [];
  const server = http.createServer((req, res) => {
    if (req.headers["x-station-key"] !== "k") { res.statusCode = 401; return res.end(); }
    if (req.url.startsWith("/api/station/next")) { asked.push(req.url); res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ item: items.shift() ?? null })); }
    if (req.url.startsWith("/api/station/clips/")) { res.setHeader("content-type", "audio/wav"); return req.url.endsWith("missing") ? (res.statusCode = 404, res.end()) : res.end(Buffer.from("RIFFxxxxWAVE")); }
    if (req.url === "/api/station/ack") { let b = ""; req.on("data", (d) => { b += d; }); req.on("end", () => { acks.push(JSON.parse(b)); res.end("{}"); }); return; }
    res.statusCode = 404; res.end();
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ url: `http://127.0.0.1:${server.address().port}`, acks, asked, close: () => server.close() })));
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "daemon-"));
const item = (over = {}) => ({ id: "i1", title: "Hello", play: true, preempt: false, audioUrl: "/api/station/clips/c1", ...over });

test("plays a queued clip: saves it, pushes it to the announce queue, reports played", async () => {
  const site = await fakeSite([item()]);
  const dir = tmp(); const commands = [];
  const d = createDaemon({ site: site.url, key: "k", dir, command: async (c) => { commands.push(c); return "1"; }, log: () => {} });
  assert.equal(await d.tick(), "played");
  assert.equal(commands.length, 1);
  assert.equal(commands[0], `announce.push annotate:comment="Hello":${path.join(dir, "i1.wav")}`);
  assert.ok(fs.existsSync(path.join(dir, "i1.wav")));
  assert.deepEqual(site.acks, [{ id: "i1", status: "played" }]);
  assert.equal(await d.tick(), "idle");
  site.close();
});

test("preempting clips use the live queue; clips not meant for air are only stored", async () => {
  const site = await fakeSite([item({ preempt: true }), item({ id: "i2", play: false })]);
  const dir = tmp(); const commands = [];
  const d = createDaemon({ site: site.url, key: "k", dir, command: async (c) => { commands.push(c); return "1"; }, log: () => {} });
  await d.tick(); await d.tick();
  assert.match(commands[0], /^announce_live\.push /);
  assert.equal(commands.length, 1);
  assert.ok(fs.existsSync(path.join(dir, "i2.wav")));
  site.close();
});

test("applies an effect, and plays the clip unprocessed when the effect fails", async () => {
  const site = await fakeSite([item({ fx: "underground" }), item({ id: "i2", fx: "underground" })]);
  const dir = tmp(); const logs = [];
  let calls = 0;
  const applyFx = async () => { if (++calls === 2) throw new Error("ffmpeg is not installed"); return Buffer.from("processed"); };
  const d = createDaemon({ site: site.url, key: "k", dir, command: async () => "1", applyFx, log: (m) => logs.push(m) });
  await d.tick(); await d.tick();
  assert.equal(fs.readFileSync(path.join(dir, "i1.mp3"), "utf8"), "processed");
  assert.ok(fs.existsSync(path.join(dir, "i2.wav")));
  assert.ok(logs.some((l) => /playing the clip unprocessed/.test(l)));
  assert.deepEqual(site.acks.map((a) => a.status), ["played", "played"]);
  site.close();
});

test("reports a failure when the audio or Liquidsoap cannot be used, and keeps going", async () => {
  const site = await fakeSite([item({ audioUrl: "/api/station/clips/missing" }), item({ id: "i2" })]);
  const d = createDaemon({ site: site.url, key: "k", dir: tmp(), command: async () => { throw new Error("connect ECONNREFUSED"); }, log: () => {} });
  assert.equal(await d.tick(), "failed");
  assert.equal(await d.tick(), "failed");
  assert.deepEqual(site.acks.map((a) => [a.id, a.status]), [["i1", "failed"], ["i2", "failed"]]);
  assert.match(site.acks[1].error, /ECONNREFUSED/);
  site.close();
});

test("throws when the site cannot be reached or the key is wrong", async () => {
  const site = await fakeSite([]);
  const bad = createDaemon({ site: site.url, key: "wrong", dir: tmp(), command: async () => "", log: () => {} });
  await assert.rejects(bad.tick(), /401/);
  site.close();
});

test("keeps only the newest files", async () => {
  const site = await fakeSite([item({ id: "a" }), item({ id: "b" }), item({ id: "c" })]);
  const dir = tmp();
  const d = createDaemon({ site: site.url, key: "k", dir, keep: 2, command: async () => "1", log: () => {} });
  for (let i = 0; i < 3; i++) { await d.tick(); await new Promise((r) => setTimeout(r, 15)); }
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".wav")).sort(), ["b.wav", "c.wav"]);
  site.close();
});

test("liquidsoapCommand talks to the telnet server", async () => {
  const seen = [];
  const server = net.createServer((s) => s.on("data", (d) => { seen.push(String(d)); s.write("7\nBye!\n"); s.end(); }));
  await new Promise((r) => server.listen(0, r));
  const reply = await liquidsoapCommand("announce.push /x.wav", { port: server.address().port });
  assert.equal(reply, "7");
  assert.equal(seen[0], "announce.push /x.wav\nexit\n");
  server.close();
});

test("passes the clip's metadata to Liquidsoap and writes a sidecar file", async () => {
  const info = { title: "Spring Fling", kind: "promo", persona: "sunny-sam", expiresAt: "2999-04-12T23:00:00.000Z", event: { name: "Spring \"Fling\"" } };
  const site = await fakeSite([item({ info, expiresAt: info.expiresAt })]);
  const dir = tmp(); const commands = [];
  const d = createDaemon({ site: site.url, key: "k", dir, command: async (c) => { commands.push(c); return "1"; }, log: () => {} });
  assert.equal(await d.tick(), "played");
  const file = path.join(dir, "i1.wav");
  assert.equal(commands[0], `announce.push annotate:title="Spring Fling",genre="promo",comment="Hello",expires="2999-04-12T23:00:00.000Z",event="Spring \\"Fling\\"",persona="sunny-sam":${file}`);
  const sidecar = JSON.parse(fs.readFileSync(path.join(dir, "i1.json"), "utf8"));
  assert.deepEqual([sidecar.kind, sidecar.expiresAt, sidecar.event.name, sidecar.file], ["promo", "2999-04-12T23:00:00.000Z", 'Spring "Fling"', "i1.wav"]);
  site.close();
});

test("never plays a clip whose expiry has passed", async () => {
  const site = await fakeSite([item({ expiresAt: "2001-01-01T00:00:00.000Z" }), item({ id: "i2", info: { expiresAt: "2001-01-01T00:00:00.000Z" } })]);
  const dir = tmp(); const commands = [];
  const d = createDaemon({ site: site.url, key: "k", dir, command: async (c) => { commands.push(c); return "1"; }, log: () => {} });
  assert.equal(await d.tick(), "skipped");
  assert.equal(await d.tick(), "skipped");
  assert.deepEqual(commands, []);
  assert.deepEqual(site.acks, [{ id: "i1", status: "skipped", error: "expired" }, { id: "i2", status: "skipped", error: "expired" }]);
  assert.equal(fs.readdirSync(dir).length, 0);
  site.close();
});

test("builds annotate URIs only when there is something to say", () => {
  assert.equal(annotateUri("/x.wav"), "/x.wav");
  assert.equal(annotateUri("/x.wav", { kind: "drop" }), 'annotate:genre="drop":/x.wav');
});

test("a daemon for one station asks only for that station's clips", async () => {
  const site = await fakeSite([]);
  const d = createDaemon({ site: site.url, key: "k", dir: tmp(), stationId: "krap-1a2b", command: async () => "", log: () => {} });
  assert.equal(await d.tick(), "idle");
  assert.deepEqual(site.asked, ["/api/station/next?station=krap-1a2b"]);
  site.close();
});
