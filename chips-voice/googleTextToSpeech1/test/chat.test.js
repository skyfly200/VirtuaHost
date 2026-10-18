const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createChat, parseWhen, parseEvery } = require('../lib/chat');
const twilio = require('../lib/twilio');
const { createChatRoutes } = require('../routes/chat');

const ME = 'whatsapp:+15551234567';

function setup(opts = {}) {
  let t = new Date(2026, 9, 18, 14, 0, 0).getTime();                        // 2pm
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const calls = [];
  const rec = (name, result) => async (...args) => { calls.push([name, ...args]); return typeof result === 'function' ? result(...args) : result; };
  const client = {
    nowPlaying: rec('nowPlaying', opts.now || { title: 'Boards of Canada - Roygbiv', listeners: 7, live: false }),
    host: rec('host', opts.host || { running: true, ready: { text: 'That was Roygbiv.' }, current: { artist: 'A', title: 'T' }, counters: { played: 2, skipped: 1, failed: 0 }, last: { text: 'Hi', played: true } }),
    hostUpdate: rec('hostUpdate', (p) => ({ running: p.enabled === undefined ? true : p.enabled, settings: { preset: p.preset, voice: p.voice, fx: p.preset === 'chip' ? 'hull' : 'none' } })),
    hostSay: rec('hostSay', { text: 'That was Tune by Band.' }),
    personas: rec('personas', { personas: [{ name: 'chip' }] }),
    stationId: rec('stationId', { text: 'Way High Radio. We are taking radio higher.', played: true }),
    skip: rec('skip', {}), setVolume: rec('setVolume', {}),
    speak: rec('speak', opts.speak || { played: true, reused: false }),
    draft: rec('draft', { text: 'Doors open at six, come early!' }),
    clips: rec('clips', [{ id: 'c1', title: 'Station ID', favorite: true }, { id: 'c2', title: 'Last call for drinks' }]),
    playClip: rec('playClip', { played: true }),
    schedule: rec('schedule', { id: 's1' }),
    schedules: rec('schedules', [{ id: 's1', name: 'Happy hour', enabled: true, nextAt: t + 3600e3 }, { id: 's2', name: 'Off', enabled: false, nextAt: 0 }]),
    deleteSchedule: rec('deleteSchedule', { ok: true }),
    fxPresets: rec('fxPresets', { available: true, presets: [{ name: 'none' }, { name: 'underground' }, { name: 'robot' }] }),
    sfx: rec('sfx', { effects: [{ name: 'ding' }, { name: 'whoosh' }] }),
  };
  const chat = createChat({ client, allowed: [ME, 'telegram:42'], now: clock.now, ...opts.chat });
  const say = async (text, from = ME) => (await chat.handle({ from, text })).reply;
  return { chat, say, calls, clock, client };
}
const names = (calls) => calls.map((c) => c[0]);

test('only allowed senders are answered, and strangers get no reply at all', async () => {
  const s = setup();
  assert.deepStrictEqual(await s.chat.handle({ from: 'whatsapp:+19998887777', text: 'skip' }), { reply: null, denied: true });
  assert.deepStrictEqual(await s.chat.handle({ from: '', text: 'skip' }), { reply: null, denied: true });
  assert.strictEqual(s.calls.length, 0);
  assert.match(await s.say('skip', ' WhatsApp: +1 555 123 4567 '), /Skipped/);                  // spacing and case in the sender id do not matter
  assert.ok(!createChat({ client: {}, allowed: [] }).isAllowed('anyone'));                      // empty allowlist: nobody
});

test('read and music commands', async () => {
  const s = setup();
  assert.match(await s.say('help'), /say <text> - announce it/);
  assert.match(await s.say(''), /Commands:/);
  assert.strictEqual(await s.say('now'), 'Now playing: Boards of Canada - Roygbiv\n7 listening\nVirtual host is on (next link: "That was Roygbiv.").');
  assert.match(await s.say('NOW'), /Now playing/);
  assert.strictEqual(await s.say('volume 40'), 'Music volume 40%.');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'setVolume'), ['setVolume', 0.4]);
  assert.match(await s.say('volume loud'), /volume 0-100/);
  assert.match(await s.say('volume 150'), /volume 0-100/);
  assert.match(await s.say('fx'), /underground, robot/);
  assert.strictEqual(await s.say('sfx'), 'ding, whoosh');
  assert.match(await s.say('dance'), /did not understand "dance"/);
  const live = setup({ now: { title: '', listeners: 3, live: true } });
  assert.match(await live.say('now'), /live DJ is on air/);
});

test('say needs a YES; NO cancels; options pick voice, effect and tone', async () => {
  const s = setup();
  const ask = await s.say('say as Rocky with underground tone sleepy: Doors open at six [sfx:ding]');
  assert.match(ask, /Announce as Rocky with underground: "Doors open at six \[sfx:ding\]"\nReply YES to confirm/);
  assert.ok(!names(s.calls).includes('speak'));                                                 // nothing went on air yet
  assert.strictEqual(await s.say('yes'), 'On air.');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'speak')[1], { text: 'Doors open at six [sfx:ding]', voice: 'Rocky', fx: 'underground', tone: 'sleepy' });
  assert.match(await s.say('yes'), /Nothing is waiting/);                                       // a confirmation works once
  await s.say('say Last call');
  assert.strictEqual(await s.say('no'), 'Cancelled.');
  assert.strictEqual(names(s.calls).filter((n) => n === 'speak').length, 1);
  await s.say('say hello');
  await s.say('skip');                                                                          // a new command replaces an unanswered one
  assert.match(await s.say('yes'), /Nothing is waiting/);
  assert.match(await s.say('say'), /say <what to announce>/);
  const plain = setup(); await plain.say('say Hello there');
  assert.ok(!names(plain.calls).includes('speak'));                                              // plain say: still waiting for the YES
  assert.deepStrictEqual(await plain.say('YES!'), 'On air.');                                    // "YES!" counts
  assert.deepStrictEqual(plain.calls.find((c) => c[0] === 'speak')[1], { text: 'Hello there', voice: undefined, fx: undefined, tone: undefined });
});

test('confirmations expire after two minutes, and a live DJ skip is reported', async () => {
  const s = setup();
  await s.say('say Late'); s.clock.advance(121000);
  assert.match(await s.say('yes'), /expired/);
  assert.ok(!names(s.calls).includes('speak'));
  const dj = setup({ speak: { played: false, reason: 'live DJ on air' } });
  await dj.say('say Hi'); assert.strictEqual(await dj.say('yes'), 'Not played: live DJ on air.');
  const reused = setup({ speak: { played: true, reused: true } });
  await reused.say('say Hi'); assert.match(await reused.say('yes'), /reused a saved clip/);
});

test('CHAT_CONFIRM=false acts immediately', async () => {
  const s = setup({ chat: { confirm: false } });
  assert.strictEqual(await s.say('say Right now'), 'On air.');
  assert.ok(names(s.calls).includes('speak'));
});

test('draft shows the text and YES puts it on air; failures are reported, not thrown', async () => {
  const s = setup();
  assert.match(await s.say('draft doors at six'), /Draft: "Doors open at six, come early!"\nReply YES to put this on air/);
  assert.strictEqual(await s.say('yes'), 'On air.');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'speak')[1], { text: 'Doors open at six, come early!' });
  assert.match(await s.say('draft'), /draft <what it is about>/);
  const broken = setup({ speak: async () => { throw new Error('quota exceeded'); } });
  await broken.say('say Hi'); assert.strictEqual(await broken.say('yes'), 'That failed: quota exceeded');
  broken.client.skip = async () => { throw new Error('liquidsoap down'); };
  assert.strictEqual(await broken.say('skip'), 'That failed: liquidsoap down');
});

test('clips and play by number', async () => {
  const s = setup();
  assert.match(await s.say('play 1'), /Send "clips" first/);
  assert.strictEqual(await s.say('clips'), '1. Station ID ★\n2. Last call for drinks\nplay <number> to air one.');
  assert.match(await s.say('play 2'), /Play "Last call for drinks"\nReply YES/);
  assert.strictEqual(await s.say('yes'), 'On air.');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'playClip').slice(1), ['c2']);
  await s.say('clips station'); assert.deepStrictEqual(s.calls.filter((c) => c[0] === 'clips')[1][1], { q: 'station' });
  assert.match(await s.say('play 9'), /Send "clips" first/);
  assert.notStrictEqual(await s.say('play 1', 'telegram:42'), await s.say('play 1'));            // lists belong to the sender who asked
});

test('host commands', async () => {
  const s = setup();
  assert.strictEqual(await s.say('host on'), 'Virtual host is on.');
  assert.strictEqual(await s.say('host off'), 'Virtual host is off.');
  assert.deepStrictEqual(s.calls.filter((c) => c[0] === 'hostUpdate').map((c) => c[1]), [{ enabled: true }, { enabled: false }]);
  assert.match(await s.say('host status'), /Virtual host: on\nTrack: A - T\nNext link: "That was Roygbiv\."\nLast: "Hi"\n2 played, 1 skipped, 0 failed/);
  assert.strictEqual(await s.say('host line Band - Tune'), '"That was Tune by Band."');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'hostSay')[1], { artist: 'Band', title: 'Tune', dryRun: true });
  assert.match(await s.say('host line nonsense'), /host line Artist - Title/);
});

test('times are understood: clock times roll to tomorrow, relative times, repeat intervals', () => {
  const now = new Date(2026, 9, 18, 14, 0, 0).getTime();
  const at = (r) => new Date(r.at);
  assert.deepStrictEqual([at(parseWhen('18:30 Doors', now)).getHours(), at(parseWhen('18:30 Doors', now)).getMinutes(), parseWhen('18:30 Doors', now).rest], [18, 30, 'Doors']);
  assert.strictEqual(at(parseWhen('9 Morning', now)).getDate(), 19);                                // 9:00 already passed today
  assert.strictEqual(at(parseWhen('6pm Go', now)).getHours(), 18);
  assert.strictEqual(at(parseWhen('12am Go', now)).getHours(), 0);
  assert.strictEqual(parseWhen('in 90m Soon', now).at, now + 90 * 60e3);
  assert.strictEqual(parseWhen('in 2 hours Later', now).at, now + 2 * 3600e3);
  assert.strictEqual(parseWhen('25:00 no', now), null);
  assert.strictEqual(parseWhen('tomorrow', now), null);
  assert.deepStrictEqual(parseEvery('every 30m Hi'), { seconds: 1800, rest: 'Hi' });
  assert.deepStrictEqual(parseEvery('every 2h Hi'), { seconds: 7200, rest: 'Hi' });
  assert.deepStrictEqual(parseEvery('Hi'), { seconds: 0, rest: 'Hi' });
});

test('schedule, list and cancel', async () => {
  const s = setup();
  assert.match(await s.say('schedule 18:30 every 1h Happy hour starts now'), /Schedule for .*every 60 min: "Happy hour starts now"\nReply YES/);
  assert.ok(!names(s.calls).includes('schedule'));
  assert.match(await s.say('yes'), /Scheduled for/);
  const sent = s.calls.find((c) => c[0] === 'schedule')[1];
  assert.deepStrictEqual([sent.spec, sent.intervalSec, new Date(sent.startAt).getHours()], [{ text: 'Happy hour starts now' }, 3600, 18]);
  assert.match(await s.say('schedule sometime Hi'), /schedule 18:30/);
  assert.match(await s.say('schedule 18:30'), /Add the text/);
  assert.match(await s.say('cancel 1'), /Send "schedules" first/);
  assert.match(await s.say('schedules'), /^1\. .* Happy hour\ncancel <number>/);                    // disabled ones are not listed
  assert.strictEqual(await s.say('cancel 1'), 'Cancelled "Happy hour".');
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'deleteSchedule').slice(1), ['s1']);
});

test('a sender is rate limited', async () => {
  const s = setup({ chat: { ratePerMinute: 3 } });
  for (let i = 0; i < 3; i++) assert.match(await s.say('now'), /Now playing/);
  assert.match(await s.say('now'), /too many messages/);
  s.clock.advance(61000);
  assert.match(await s.say('now'), /Now playing/);
  const other = await s.chat.handle({ from: 'telegram:42', text: 'now' });                       // other senders are not affected
  assert.match(other.reply, /Now playing/);
});

test('trusted callers (already authenticated) skip the allowlist but keep the confirmation', async () => {
  const s = setup();
  assert.match(await s.chat.handleTrusted({ from: 'api:default', text: 'say Hello' }), /Reply YES/);
  assert.strictEqual(await s.chat.handleTrusted({ from: 'api:default', text: 'yes' }), 'On air.');
});

test('Twilio signatures: the documented example verifies, tampering does not', () => {
  // The example from Twilio's request validation documentation.
  const url = 'https://mycompany.com/myapp.php?foo=1&bar=2';
  const params = { CallSid: 'CA1234567890ABCDE', Caller: '+14158675310', Digits: '1234', From: '+14158675310', To: '+18005551212' };
  assert.strictEqual(twilio.signature(url, params, '12345'), 'GvWf1cFY/Q7PnoempGyD5oXAezc=');
  assert.ok(twilio.valid(url, params, '12345', 'GvWf1cFY/Q7PnoempGyD5oXAezc='));
  assert.ok(!twilio.valid(url, { ...params, Digits: '9999' }, '12345', 'GvWf1cFY/Q7PnoempGyD5oXAezc='));
  assert.ok(!twilio.valid(url, params, 'other', 'GvWf1cFY/Q7PnoempGyD5oXAezc='));
  assert.ok(!twilio.valid(url, params, '12345', '') && !twilio.valid(url, params, '', 'x'));
  assert.strictEqual(twilio.twiml('a <b> & "c"'), '<?xml version="1.0" encoding="UTF-8"?><Response><Message>a &lt;b&gt; &amp; &quot;c&quot;</Message></Response>');
  assert.strictEqual(twilio.twiml(null), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
});

async function boot(opts = {}) {
  const sent = [];
  const chat = { handle: async (m) => { sent.push(m); return m.from === 'whatsapp:+1' ? { reply: 'Hi <there>' } : { reply: null, denied: true }; },
    handleTrusted: async (m) => { sent.push(m); return `trusted:${m.text}`; } };
  const telegramCalls = [];
  const fetchImpl = async (url, init) => { telegramCalls.push([String(url), JSON.parse(init.body)]); return new Response('{}'); };
  const routes = createChatRoutes({ chat, twilioAuthToken: 'tok', publicUrl: 'https://radio.test/', telegramToken: 'BOT', telegramSecret: 'shh', telegramApi: 'https://tg.test', fetchImpl, ...opts });
  const app = express();
  app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use(routes.webhooks);
  app.use((req, res, next) => (req.get('x-api-key') === 'k' ? next() : res.status(401).json({ error: 'login required' })), routes.router);
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  return { base: `http://127.0.0.1:${server.address().port}`, sent, telegramCalls, close: () => server.close() };
}

test('Twilio webhook: signature checked against the public URL, replies as TwiML, strangers get an empty reply', async (t) => {
  const s = await boot(); t.after(() => s.close());
  const post = (params, sig) => fetch(`${s.base}/chat/twilio`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(sig ? { 'X-Twilio-Signature': sig } : {}) }, body: new URLSearchParams(params).toString() });
  const params = { From: 'whatsapp:+1', Body: 'now' };
  const good = twilio.signature('https://radio.test/chat/twilio', params, 'tok');
  const ok = await post(params, good);
  assert.deepStrictEqual([ok.status, ok.headers.get('content-type').includes('xml'), await ok.text()], [200, true, '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Hi &lt;there&gt;</Message></Response>']);
  assert.deepStrictEqual(s.sent, [{ from: 'whatsapp:+1', text: 'now' }]);
  assert.strictEqual((await post(params, 'forged')).status, 403);
  assert.strictEqual((await post(params)).status, 403);
  assert.strictEqual((await post({ ...params, Body: 'skip' }, good)).status, 403);                  // signature does not cover a changed body
  assert.strictEqual(s.sent.length, 1);
  const stranger = { From: 'whatsapp:+999', Body: 'skip' };
  const quiet = await post(stranger, twilio.signature('https://radio.test/chat/twilio', stranger, 'tok'));
  assert.strictEqual(await quiet.text(), '<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  const off = await boot({ twilioAuthToken: '' }); t.after(() => off.close());
  assert.strictEqual((await fetch(`${off.base}/chat/twilio`, { method: 'POST' })).status, 503);
});

async function telegramApp(chatReply) {
  const calls = [];
  const sent = [];
  const chat = { handle: async (m) => { sent.push(m); return chatReply(m); } };
  const r = createChatRoutes({ chat, telegramToken: 'BOT', telegramSecret: 'shh', telegramApi: 'https://tg.test', fetchImpl: async (u, i) => { calls.push([String(u), JSON.parse(i.body)]); return new Response('{}'); } });
  const app = express(); app.use(express.json()); app.use(r.webhooks);
  const server = await new Promise((x) => { const sv = app.listen(0, '127.0.0.1', () => x(sv)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body, secret) => fetch(`${base}/chat/telegram`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(secret ? { 'X-Telegram-Bot-Api-Secret-Token': secret } : {}) }, body: JSON.stringify(body) });
  return { post, calls, sent, base, close: () => server.close() };
}

test('Telegram webhook: secret header required, replies go through the Bot API, strangers get nothing', async (t) => {
  const tg = await telegramApp((m) => (m.from === 'telegram:5' ? { reply: 'pong' } : { reply: null, denied: true })); t.after(() => tg.close());
  const message = (id, text = 'hi') => ({ message: { text, from: { id }, chat: { id: id + 1000 } } });
  assert.strictEqual((await tg.post(message(5))).status, 403);                                       // no secret
  assert.strictEqual((await tg.post(message(5), 'wrong')).status, 403);
  assert.strictEqual(tg.sent.length, 0);                                                              // forged calls never reach the chat layer
  const ok = await tg.post(message(5), 'shh');
  assert.deepStrictEqual([ok.status, (await ok.json()).ok], [200, true]);
  assert.deepStrictEqual(tg.sent[0], { from: 'telegram:5', text: 'hi' });
  assert.deepStrictEqual(tg.calls, [['https://tg.test/botBOT/sendMessage', { chat_id: 1005, text: 'pong' }]]);
  await tg.post(message(99), 'shh');                                                                  // not allowed: handled, but nothing is sent back
  assert.strictEqual(tg.calls.length, 1);
  await tg.post({ edited_message: {}, update_id: 1 }, 'shh');                                         // other update types are ignored
  await tg.post({ message: { from: { id: 5 }, chat: { id: 1 }, sticker: {} } }, 'shh');             // no text
  assert.strictEqual(tg.sent.length, 2);
  const none = await boot({ telegramToken: '' }); t.after(() => none.close());
  assert.strictEqual((await fetch(`${none.base}/chat/telegram`, { method: 'POST' })).status, 503);    // not configured: refuses everything
});

test('generic /chat/message needs the API key and uses the trusted path', async (t) => {
  const s = await boot(); t.after(() => s.close());
  const post = (headers) => fetch(`${s.base}/chat/message`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ from: 'slack:U1', text: 'now' }) });
  assert.strictEqual((await post({})).status, 401);
  const ok = await post({ 'x-api-key': 'k' });
  assert.deepStrictEqual(await ok.json(), { reply: 'trusted:now' });
  assert.deepStrictEqual(s.sent[0], { from: 'api:slack:U1', text: 'now' });
});

test('CHIP: list personas, switch with a voice, and play a station ID after YES', async () => {
  const s = setup({ host: { running: true, settings: { preset: '' }, counters: {} } });
  assert.match(await s.say('host persona'), /Personas: chip\.\nActive: none\./);
  assert.match(await s.say('host persona chip as Grumble'), /Host persona is now chip \(voice Grumble\), effect hull\./);
  assert.deepStrictEqual(s.calls.filter((c) => c[0] === 'hostUpdate').pop()[1], { preset: 'chip', voice: 'Grumble' });
  assert.match(await s.say('id'), /Reply YES/);
  assert.strictEqual(s.calls.some((c) => c[0] === 'stationId'), false);                            // nothing on air before YES
  assert.match(await s.say('yes'), /On air: "Way High Radio/);
  assert.deepStrictEqual(s.calls.find((c) => c[0] === 'stationId').slice(1), [true]);
});
