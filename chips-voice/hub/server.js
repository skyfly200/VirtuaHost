#!/usr/bin/env node
// Starts the hub. Env: HUB_KEY (required, 12+ chars), HUB_PORT=3200, HUB_DATA=./data/hub.json, VOICE_URL, VOICE_KEY,
// HUB_CORS_ORIGIN (default *), HUB_STATIC (a folder of web files to serve at /, e.g. ../web).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createHub } = require('./hub');
const { createStore } = require('./store');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(root, req, res) {
  const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
  let file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  try { if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html'); } catch (err) { return false; }
  if (!fs.existsSync(file)) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function main() {
  const store = createStore(process.env.HUB_DATA || path.join(__dirname, 'data', 'hub.json'));
  const hub = createHub({
    store, key: process.env.HUB_KEY || '', voiceUrl: process.env.VOICE_URL || '', voiceKey: process.env.VOICE_KEY || '', corsOrigin: process.env.HUB_CORS_ORIGIN || '*',
  });
  const staticRoot = process.env.HUB_STATIC ? path.resolve(process.env.HUB_STATIC) : '';
  const server = http.createServer((req, res) => {
    if (staticRoot && req.method === 'GET' && serveStatic(staticRoot, req, res)) return;
    hub.handle(req, res);
  });
  hub.start();
  const port = parseInt(process.env.HUB_PORT || '3200', 10);
  server.listen(port, process.env.HUB_HOST || '0.0.0.0', () => console.error(`hub listening on ${port}`));
  const bye = () => { store.flush(); process.exit(0); };
  process.on('SIGTERM', bye); process.on('SIGINT', bye);
}

if (require.main === module) {
  try { main(); } catch (err) { console.error(err.message); process.exit(1); }
}
module.exports = { serveStatic };
