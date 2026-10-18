const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serveStatic } = require('../server');

test('static files are served from the web folder only, and the real web apps are all there', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'web-'));
  fs.mkdirSync(path.join(root, 'lab'));
  fs.writeFileSync(path.join(root, 'lab', 'index.html'), '<p>lab</p>');
  fs.writeFileSync(path.join(root, '..', `secret-${path.basename(root)}.txt`), 'secret');
  const server = http.createServer((req, res) => { if (!serveStatic(root, req, res)) { res.writeHead(404); res.end('nf'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const get = async (p) => { const res = await fetch(`http://127.0.0.1:${server.address().port}${p}`); return { status: res.status, type: res.headers.get('content-type'), text: await res.text() }; };
  assert.deepStrictEqual(await get('/lab/'), { status: 200, type: 'text/html; charset=utf-8', text: '<p>lab</p>' });
  assert.strictEqual((await get('/nope')).status, 404);
  assert.strictEqual((await get(`/..%2Fsecret-${path.basename(root)}.txt`)).status, 404);          // no escaping the folder
  assert.strictEqual((await get('/%2e%2e/%2e%2e/etc/passwd')).status, 404);
  server.close(); server.closeAllConnections?.();

  const web = path.join(__dirname, '..', '..', 'web');
  for (const f of ['index.html', 'shared/kit.js', 'shared/kit.css', 'lab/index.html', 'lab/lab.js', 'panel/index.html', 'panel/panel.js']) assert.ok(fs.existsSync(path.join(web, f)), f);
});
