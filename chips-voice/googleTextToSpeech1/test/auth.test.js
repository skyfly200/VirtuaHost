const test = require('node:test');
const assert = require('node:assert');
const { createAuth, hashPassword, verifyPassword } = require('../auth');

const hash = hashPassword('correct horse battery');
let clock = 1_000_000;
const make = (extra = {}) => createAuth({ passwordHash: hash, secret: 's3cret', apiKey: 'k', now: () => clock, ...extra });

function res() {
  return { code: 200, body: null, headers: {}, set(k, v) { this.headers[k] = v; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
}
const login = (auth, body, ip = '1.1.1.1') => { const r = res(); auth.login({ ip, body }, r); return r; };
const guard = (auth, headers = {}) => {
  let passed = false; const r = res();
  auth.requireAuth({ get: (h) => headers[h.toLowerCase()] }, r, () => { passed = true; });
  return { passed, r };
};

test('password hashing', () => {
  assert.ok(verifyPassword('correct horse battery', hash));
  assert.ok(!verifyPassword('wrong', hash));
  assert.ok(!verifyPassword('x', 'garbage'));
  assert.notStrictEqual(hashPassword('same'), hashPassword('same')); // salted
});

test('login issues a token that unlocks the API', () => {
  const auth = make();
  const r = login(auth, { username: 'admin', password: 'correct horse battery' });
  assert.strictEqual(r.code, 200);
  assert.ok(guard(auth, { authorization: `Bearer ${r.body.token}` }).passed);
});

test('bad credentials and no credentials are rejected', () => {
  const auth = make();
  assert.strictEqual(login(auth, { username: 'admin', password: 'nope' }).code, 401);
  assert.strictEqual(login(auth, { username: 'root', password: 'correct horse battery' }).code, 401);
  assert.strictEqual(guard(auth).r.code, 401);
  assert.strictEqual(guard(auth, { authorization: 'Bearer junk' }).r.code, 401);
});

test('tampered and expired tokens are rejected', () => {
  const auth = make({ sessionHours: 1 });
  const token = auth.issueToken('admin');
  const [v, payload, sig] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', exp: clock + 1e12 })).toString('base64url');
  assert.ok(!auth.verifyToken(`${v}.${forged}.${sig}`));
  assert.ok(auth.verifyToken(token));
  clock += 2 * 3600 * 1000;
  assert.ok(!auth.verifyToken(token));
  // a token signed with another secret is rejected
  assert.ok(!make({ secret: 'other' }).verifyToken(token));
});

test('API key still works for scripts', () => {
  const auth = make();
  assert.ok(guard(auth, { 'x-api-key': 'k' }).passed);
  assert.ok(guard(auth, { authorization: 'Bearer k' }).passed);
  assert.ok(!guard(auth, { 'x-api-key': 'wrong' }).passed);
});

test('login is throttled after repeated failures, then recovers', () => {
  const auth = make();
  for (let i = 0; i < 5; i++) login(auth, { username: 'admin', password: 'bad' }, '9.9.9.9');
  const blocked = login(auth, { username: 'admin', password: 'correct horse battery' }, '9.9.9.9');
  assert.strictEqual(blocked.code, 429);
  assert.ok(blocked.headers['Retry-After']);
  assert.strictEqual(login(auth, { username: 'admin', password: 'correct horse battery' }, '8.8.8.8').code, 200);
  clock += 16 * 60 * 1000;
  assert.strictEqual(login(auth, { username: 'admin', password: 'correct horse battery' }, '9.9.9.9').code, 200);
});

test('nothing configured means open (dev only)', () => {
  const auth = createAuth({});
  assert.ok(!auth.enabled);
  assert.ok(guard(auth).passed);
});
