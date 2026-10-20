#!/usr/bin/env node
// Starts the hub. Env: HUB_KEY (required, 12+ chars), HUB_PORT=3200, HUB_DATA=./data/hub.json, VOICE_URL, VOICE_KEY,
// HUB_CORS_ORIGIN (only needed if a browser calls the hub directly; the web UI reaches it through the site's /api/hub proxy).
const http = require('http');
const path = require('path');
const { createHub } = require('./hub');
const { createStore } = require('./store');

function main() {
  const store = createStore(process.env.HUB_DATA || path.join(__dirname, 'data', 'hub.json'));
  const hub = createHub({
    store, key: process.env.HUB_KEY || '', voiceUrl: process.env.VOICE_URL || '', voiceKey: process.env.VOICE_KEY || '', corsOrigin: process.env.HUB_CORS_ORIGIN || '*',
  });
  const server = http.createServer((req, res) => hub.handle(req, res));
  hub.start();
  const port = parseInt(process.env.HUB_PORT || '3200', 10);
  server.listen(port, process.env.HUB_HOST || '0.0.0.0', () => console.error(`hub listening on ${port}`));
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}
