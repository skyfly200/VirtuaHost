// Manage the station from a chat: "now", "skip", "say Doors open at six", "host on" ...
//
// Transport-neutral: an adapter (WhatsApp/SMS via Twilio, Telegram, or the generic /chat/message endpoint) hands over
// who sent the message and the text, and sends back the reply. Safety rules:
//   - Only senders on CHAT_ALLOWED are answered at all; everyone else gets no reply.
//   - Anything that puts audio on the public stream or schedules it must be confirmed with YES (unless CHAT_CONFIRM=false),
//     and a pending confirmation expires after two minutes.
//   - Each sender is limited to a few messages a minute.
const HELP = `Commands:
now - what is playing
skip - next track
volume 0-100 - music level
say <text> - announce it (asks YES first)
say as Rocky with underground: <text> - choose voice and effect
draft <what it is about> - AI writes it, then YES to air
clips [words] - recent clips; play <number> to air one
host on|off|status - the virtual host
host line Artist - Title - preview a host link
host persona [chip] [as Voice] - list host personas, or switch (CHIP is Way High Radio's computer DJ)
id - a station ID in the host persona's style (asks YES first)
schedule 18:30 <text> or schedule in 2h every 1h <text>
schedules, cancel <number>
fx, sfx - list effects and sound effects
In text, [sfx:ding] adds a sound effect.`;

class ChatError extends Error {}

const normalize = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

// "18:30", "6pm", "in 45m", "in 2h" -> a timestamp, relative to `now`.
function parseWhen(text, now) {
  const rel = text.match(/^in\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)\b\s*/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = /^h/i.test(rel[2]) ? n * 3600e3 : n * 60e3;
    return { at: now + ms, rest: text.slice(rel[0].length) };
  }
  const clock = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b\s*/i);
  if (clock) {
    let h = Number(clock[1]);
    const min = Number(clock[2] || 0);
    if (clock[3]) { if (h < 1 || h > 12) return null; h = (h % 12) + (/pm/i.test(clock[3]) ? 12 : 0); }
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1);          // already past today: tomorrow
    return { at: d.getTime(), rest: text.slice(clock[0].length) };
  }
  return null;
}

function parseEvery(text) {
  const m = text.match(/^every\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?)\b\s*/i);
  if (!m) return { seconds: 0, rest: text };
  const seconds = Number(m[1]) * (/^h/i.test(m[2]) ? 3600 : 60);
  return { seconds, rest: text.slice(m[0].length) };
}

function createChat({ client, allowed = [], confirm = true, now = Date.now, ttlMs = 120000, ratePerMinute = 12, maxReply = 1500 }) {
  const allow = new Set(allowed.map(normalize).filter(Boolean));
  const pending = new Map();      // sender -> { action, text, expires }
  const lists = new Map();        // sender -> last clip / schedule list for "play 2" and "cancel 1"
  const hits = new Map();

  const isAllowed = (from) => allow.has(normalize(from));
  const clip = (s, n = 140) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function limited(from) {
    const t = now();
    const h = (hits.get(from) || []).filter((x) => t - x < 60000);
    h.push(t);
    hits.set(from, h);
    return h.length > ratePerMinute;
  }

  async function onAir(from, description, action) {
    if (!confirm) return action();
    pending.set(from, { action, expires: now() + ttlMs });
    return `${description}\nReply YES to confirm or NO to cancel.`;
  }

  const commands = {
    help: async () => HELP,

    now: async () => {
      const [np, host] = await Promise.all([client.nowPlaying().catch((e) => ({ error: e.message })), client.host().catch(() => null)]);
      if (np.error) return `Cannot read the stream: ${np.error}`;
      const lines = [np.live ? 'A live DJ is on air.' : `Now playing: ${np.title || 'nothing'}`, `${np.listeners} listening`];
      if (host && host.running) lines.push(`Virtual host is on${host.ready ? ` (next link: "${clip(host.ready.text, 80)}")` : ''}.`);
      return lines.join('\n');
    },

    skip: async () => { await client.skip(); return 'Skipped.'; },

    volume: async (from, arg) => {
      const n = Number(arg);
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new ChatError('Say "volume 0-100".');
      await client.setVolume(n / 100);
      return `Music volume ${Math.round(n)}%.`;
    },

    say: async (from, arg) => {
      // say [as Voice] [with effect] [tone words]: text
      const m = arg.match(/^(?:as\s+(\S+)\s+)?(?:with\s+(\S+)\s+)?(?:tone\s+([^:]{1,60}?)\s*:\s*)?:?\s*([\s\S]+)$/i);
      if (!m || !m[4].trim()) throw new ChatError('Say "say <what to announce>".');
      const spec = { text: m[4].trim(), voice: m[1] || undefined, fx: m[2] && m[2].toLowerCase() !== 'none' ? m[2] : undefined, tone: m[3] || undefined };
      return onAir(from, `Announce${spec.voice ? ` as ${spec.voice}` : ''}${spec.fx ? ` with ${spec.fx}` : ''}: "${clip(spec.text)}"`, async () => {
        const out = await client.speak(spec);
        return out.played === false ? `Not played: ${out.reason}.` : `On air${out.reused ? ' (reused a saved clip)' : ''}.`;
      });
    },

    draft: async (from, arg) => {
      if (!arg) throw new ChatError('Say "draft <what it is about>".');
      const out = await client.draft({ prompt: arg });
      return onAir(from, `Draft: "${out.text}"`, async () => {
        const res = await client.speak({ text: out.text });
        return res.played === false ? `Not played: ${res.reason}.` : 'On air.';
      }).then((reply) => (confirm ? reply.replace('Reply YES to confirm', 'Reply YES to put this on air') : reply));
    },

    clips: async (from, arg) => {
      const list = (await client.clips(arg ? { q: arg } : {})).slice(0, 8);
      lists.set(from, { kind: 'clips', items: list });
      return list.length ? list.map((c, i) => `${i + 1}. ${clip(c.title, 60)}${c.favorite ? ' ★' : ''}`).join('\n') + '\nplay <number> to air one.' : 'No clips found.';
    },

    play: async (from, arg) => {
      const last = lists.get(from);
      const idx = Number(arg);
      const item = last && last.kind === 'clips' && Number.isInteger(idx) ? last.items[idx - 1] : null;
      if (!item) throw new ChatError('Send "clips" first, then "play <number>".');
      return onAir(from, `Play "${clip(item.title, 80)}"`, async () => {
        const out = await client.playClip(item.id);
        return out.played === false ? `Not played: ${out.reason}.` : 'On air.';
      });
    },

    host: async (from, arg) => {
      const [sub, ...rest] = arg.split(/\s+/);
      const s = (sub || 'status').toLowerCase();
      if (s === 'on' || s === 'off') {
        const h = await client.hostUpdate({ enabled: s === 'on' });
        return `Virtual host is ${h.running ? 'on' : 'off'}.`;
      }
      if (s === 'persona' || s === 'personas') {
        const m = rest.join(' ').match(/^(\S+)(?:\s+as\s+(\S+))?$/i);
        if (!m) {
          const { personas } = await client.personas();
          const h = await client.host();
          return `Personas: ${personas.map((p) => p.name).join(', ')}.\nActive: ${h.settings && h.settings.preset ? h.settings.preset : 'none'}.\nSay "host persona ${personas[0] ? personas[0].name : 'chip'} as <Voice>" to switch.`;
        }
        const patch = { preset: m[1].toLowerCase() };
        if (m[2]) patch.voice = m[2];
        const h = await client.hostUpdate(patch);
        const st = h.settings || {};
        return `Host persona is now ${st.preset || patch.preset}${st.voice ? ` (voice ${st.voice})` : ''}, effect ${st.fx || 'none'}. ${h.running ? '' : 'The host is off; "host on" starts it.'}`.trim();
      }
      if (s === 'line') {
        const m = rest.join(' ').match(/^(.+?)\s+-\s+(.+)$/);
        if (!m) throw new ChatError('Say "host line Artist - Title".');
        const out = await client.hostSay({ artist: m[1], title: m[2], dryRun: true });
        return `"${out.text}"`;
      }
      const h = await client.host();
      return [`Virtual host: ${h.running ? 'on' : 'off'}`, h.current ? `Track: ${h.current.artist} - ${h.current.title}` : null,
        h.ready ? `Next link: "${clip(h.ready.text, 100)}"` : null, h.last ? `Last: "${clip(h.last.text, 100)}"${h.last.played ? '' : ` (skipped: ${h.last.reason})`}` : null,
        `${h.counters.played} played, ${h.counters.skipped} skipped, ${h.counters.failed} failed`, h.error ? `Problem: ${h.error}` : null].filter(Boolean).join('\n');
    },

    id: async (from) => onAir(from, 'Play a station ID in the host persona\'s style', async () => {
      const out = await client.stationId(true);
      return out.played === false ? `Not played: ${out.reason}.` : `On air: "${clip(out.text, 120)}"`;
    }),

    schedule: async (from, arg) => {
      const when = parseWhen(arg, now());
      if (!when) throw new ChatError('Say "schedule 18:30 <text>" or "schedule in 2h every 1h <text>".');
      const every = parseEvery(when.rest);
      const text = every.rest.trim();
      if (!text) throw new ChatError('Add the text to announce.');
      const at = new Date(when.at);
      const label = `${at.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}${every.seconds ? `, every ${Math.round(every.seconds / 60)} min` : ''}`;
      return onAir(from, `Schedule for ${label}: "${clip(text)}"`, async () => {
        await client.schedule({ spec: { text }, startAt: when.at, intervalSec: every.seconds, count: 0 });
        return `Scheduled for ${label}.`;
      });
    },

    schedules: async (from) => {
      const list = (await client.schedules()).filter((s) => s.enabled).slice(0, 8);
      lists.set(from, { kind: 'schedules', items: list });
      return list.length ? list.map((s, i) => `${i + 1}. ${new Date(s.nextAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })} ${clip(s.name, 50)}`).join('\n') + '\ncancel <number> to remove one.' : 'Nothing scheduled.';
    },

    cancel: async (from, arg) => {
      const last = lists.get(from);
      const item = last && last.kind === 'schedules' ? last.items[Number(arg) - 1] : null;
      if (!item) throw new ChatError('Send "schedules" first, then "cancel <number>".');
      await client.deleteSchedule(item.id);
      return `Cancelled "${clip(item.name, 50)}".`;
    },

    fx: async () => {
      const f = await client.fxPresets();
      return f.available ? f.presets.filter((p) => p.name !== 'none').map((p) => p.name).join(', ') : 'Effects need ffmpeg on the server.';
    },

    sfx: async () => {
      const s = await client.sfx();
      return s.effects.map((e) => e.name).join(', ');
    },
  };

  return {
    HELP,
    isAllowed,

    // For callers that are already authenticated (the API key or a login): no allowlist, same commands and confirmations.
    async handleTrusted({ from, text }) {
      return (await run({ from, text })).reply;
    },

    // Returns { reply } (a string), or { reply: null, denied: true } for senders who are not allowed.
    async handle({ from, text }) {
      if (!isAllowed(from)) return { reply: null, denied: true };
      return run({ from, text });
    },
  };

  async function run({ from, text }) {
    {
      if (limited(from)) return { reply: 'Slow down a little: too many messages.' };
      const message = String(text || '').trim();
      if (!message) return { reply: HELP };
      const word = message.split(/\s+/)[0].toLowerCase().replace(/[.!]+$/, '');

      // A pending confirmation is answered by yes / no.
      const waiting = pending.get(from);
      if (waiting && (word === 'yes' || word === 'y' || word === 'no' || word === 'n')) {
        pending.delete(from);
        if (word.startsWith('n')) return { reply: 'Cancelled.' };
        if (now() > waiting.expires) return { reply: 'That confirmation expired. Send the command again.' };
        try { return { reply: clip(await waiting.action(), maxReply) }; } catch (err) { return { reply: `That failed: ${err.message}` }; }
      }
      if (word === 'yes' || word === 'no') return { reply: 'Nothing is waiting for confirmation.' };

      const command = commands[word];
      if (!command) return { reply: `I did not understand "${clip(word, 20)}". Send "help" for the commands.` };
      pending.delete(from);                                         // a new command replaces an unanswered confirmation
      const arg = message.slice(message.indexOf(word) + word.length).trim();
      try {
        return { reply: clip(String(await command(from, arg)), maxReply) };
      } catch (err) {
        return { reply: err instanceof ChatError ? err.message : `That failed: ${err.message}` };
      }
    }
  }
}

module.exports = { createChat, parseWhen, parseEvery, HELP };
