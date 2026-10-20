// Flier tab: a picture (or pasted text) of an event flier becomes a promo clip that stops airing when the event is over.
//   1. read the flier  ->  2. check the details  ->  3. write promos in a persona's voice  ->  4. hear it  ->  5. save, send, repeat until the event.
// The saved clip carries the event as metadata and an expiry, so nothing downstream plays it after the date (docs/CLIP-METADATA.md).
import { h, clear, toast } from '../shared/kit.js';
import { createSpeaker } from '../shared/speaker.js';

const MAX_SIDE = 1600;
const when = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

// "2030-04-12T19:30" as the wall clock reads in `tz`, from an instant.
function toLocalInput(iso, tz) {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Shrinks a picture before it is sent: phones take 10 MB photos, the model needs a few hundred KB.
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale); canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

export async function mountFlier(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let options; let personas = [];
  try {
    [options, { personas }] = await Promise.all([api.get('/options'), api.get('/personas').catch(() => ({ personas: [] }))]);
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load: ${err.message}`)); return; }
  const speaker = createSpeaker(api, options.features);
  await speaker.loadLibrary();

  const s = {
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', image: '', pasted: '', thumb: '',
    event: null, personaId: '', count: 3, length: 'short', variants: [], chosen: 0, stopRule: 'end',
    audio: null, saved: null,
  };

  const status = h('p', { class: 'small muted', role: 'status' });
  const body = h('div', { class: 'stack' });
  const say = (msg, bad = false) => { status.textContent = msg; status.classList.toggle('bad', bad); };

  // ---------- 1. the flier ----------
  function pickerCard() {
    const thumb = h('img', { alt: 'The flier', style: 'max-width:220px;max-height:260px;border-radius:8px;display:none' });
    if (s.thumb) { thumb.src = s.thumb; thumb.style.display = 'block'; }
    const file = h('input', { type: 'file', accept: 'image/*', 'aria-label': 'Flier picture', onchange: async (e) => {
      const f = e.target.files[0]; if (!f) return;
      try { s.image = await shrink(f); s.thumb = s.image; thumb.src = s.thumb; thumb.style.display = 'block'; say(`Picture ready (${Math.round(s.image.length * 0.75 / 1024)} KB).`); } catch { say('Could not open that picture.', true); }
    } });
    const text = h('textarea', { rows: 4, placeholder: 'Or paste the flier\'s text here, for example: "Spring Fling! Friday April 12, 7:30pm at The Barn. Live music, $10."', 'aria-label': 'Flier text', oninput: (e) => { s.pasted = e.target.value; } });
    text.value = s.pasted;
    const tz = h('input', { value: s.tz, list: 'tz-list', 'aria-label': 'Time zone', oninput: (e) => { s.tz = e.target.value.trim(); } });
    const zones = h('datalist', { id: 'tz-list' }, (Intl.supportedValuesOf ? Intl.supportedValuesOf('timeZone') : []).map((z) => h('option', { value: z })));
    const read = h('button', { class: 'primary', type: 'button', onclick: async () => {
      if (!s.image && !s.pasted.trim()) { say('Choose a picture or paste the text first.', true); return; }
      read.disabled = true; say('Reading the flier (this uses the AI and can take a few seconds)...');
      try {
        const { event } = await api.post('/flier/read', { ...(s.image ? { image: s.image } : {}), ...(s.pasted.trim() ? { text: s.pasted } : {}), tz: s.tz });
        s.event = event; s.variants = []; s.audio = null; s.saved = null;
        say('Read. Check every detail below: the promo repeats exactly what is here.'); paint();
      } catch (err) { say(err.message, true); } finally { read.disabled = false; }
    } }, 'Read the flier');
    return h('section', { class: 'card' }, h('h2', {}, '1. The flier'),
      h('p', { class: 'muted small' }, 'Upload a picture of the flier or poster (a phone photo is fine), or paste its text. Nothing is posted anywhere.'),
      h('div', { class: 'row' }, file, thumb),
      text, h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Time zone of the event', tz, zones)), h('div', { class: 'row' }, read));
  }

  // ---------- 2. the details ----------
  function eventCard() {
    const e = s.event;
    const local = (iso) => toLocalInput(iso, e.tz);
    const draft = { startsAtLocal: e.startsAtLocal || local(e.startsAt), endsAtLocal: e.endsAtLocal || (e.endGuessed ? local(e.endsAt) : local(e.endsAt)) };
    e.startsAtLocal = draft.startsAtLocal; e.endsAtLocal = draft.endsAtLocal;
    const txt = (label, key, ph = '') => h('label', { class: 'field' }, label, h('input', { value: e[key] || '', placeholder: ph, oninput: (ev) => { e[key] = ev.target.value; } }));
    return h('section', { class: 'card' }, h('h2', {}, '2. The details'),
      e.notes && e.notes.length ? h('p', { class: 'note warn small' }, `The reader noticed: ${e.notes.join(' · ')}`) : null,
      e.endGuessed ? h('p', { class: 'note warn small' }, 'The flier has no end time, so I assumed three hours. The promo stops airing at the end time below, so set it if you know it.') : null,
      !e.startsAt ? h('p', { class: 'note warn small' }, 'No date was found. Without one the promo cannot expire automatically: add the start and end.') : null,
      h('div', { class: 'grid' },
        txt('Event name', 'name'),
        h('div', { class: 'grid cols' },
          h('label', { class: 'field' }, `Starts (${e.tz})`, h('input', { type: 'datetime-local', value: draft.startsAtLocal, onchange: (ev) => { e.startsAtLocal = ev.target.value; e.startsAt = undefined; } })),
          h('label', { class: 'field' }, `Ends (${e.tz})`, h('input', { type: 'datetime-local', value: draft.endsAtLocal, onchange: (ev) => { e.endsAtLocal = ev.target.value; e.endsAt = undefined; e.endGuessed = false; } }))),
        h('div', { class: 'grid cols' }, txt('Venue', 'venue'), txt('Address', 'address'), txt('Price', 'price', 'e.g. $10 at the door, free')),
        h('div', { class: 'grid cols' }, txt('Website', 'url'), txt('Phone', 'phone'),
          h('label', { class: 'field' }, 'With (comma separated)', h('input', { value: (e.performers || []).join(', '), oninput: (ev) => { e.performers = ev.target.value.split(',').map((x) => x.trim()).filter(Boolean); } }))),
        txt('One-line description', 'description')));
  }

  // ---------- 3. the promos ----------
  function promoCard() {
    const persona = h('select', { 'aria-label': 'Persona', onchange: (ev) => { s.personaId = ev.target.value; } }, h('option', { value: '' }, 'No persona (plain host)'),
      personas.map((p) => h('option', { value: p.id, selected: p.id === s.personaId }, `${p.emoji || ''} ${p.name}`.trim())));
    const length = h('select', { 'aria-label': 'Length', onchange: (ev) => { s.length = ev.target.value; } },
      [['short', 'Short (about 10 seconds)'], ['medium', 'Medium (about 20 seconds)']].map(([v, t]) => h('option', { value: v, selected: v === s.length }, t)));
    const count = h('select', { 'aria-label': 'How many', onchange: (ev) => { s.count = Number(ev.target.value); } }, [1, 2, 3, 4].map((n) => h('option', { value: n, selected: n === s.count }, `${n} version${n > 1 ? 's' : ''}`)));
    const write = h('button', { class: 'primary', type: 'button', onclick: async () => {
      write.disabled = true; say('Writing the promos...');
      try {
        const out = await api.post('/flier/promo', { event: s.event, tz: s.tz, personaId: s.personaId, count: s.count, length: s.length });
        s.event = { ...s.event, ...out.event }; s.variants = out.variants; s.chosen = 0; s.audio = null; s.saved = null;
        say(`Written. Edit the one you like, then make the audio. The promo will say: "${out.event.whenSpoken || 'no date'}".`); paint();
      } catch (err) { say(err.message, true); } finally { write.disabled = false; }
    } }, s.variants.length ? 'Write them again' : 'Write the promos');
    return h('section', { class: 'card' }, h('h2', {}, '3. The promo'),
      h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Who is speaking', persona), h('label', { class: 'field' }, 'Length', length), h('label', { class: 'field' }, 'How many', count)),
      h('div', { class: 'row' }, write),
      s.variants.map((v, i) => h('div', { class: 'clip' },
        h('label', { class: 'row' }, h('input', { type: 'radio', name: 'variant', checked: i === s.chosen, onchange: () => { s.chosen = i; s.audio = null; paint(); } }), h('b', {}, `Version ${i + 1}`)),
        Object.assign(h('textarea', { rows: 3, 'aria-label': `Version ${i + 1}`, oninput: (ev) => { s.variants[i] = ev.target.value; } }), { value: v }))));
  }

  // ---------- 4. the audio ----------
  const STOP = [['end', 'when the event ends'], ['start', 'when the event starts'], ['hour', 'an hour before it starts'], ['day', 'a day before it starts']];
  function expiryFor(e) {
    const start = e.startsAt && Date.parse(e.startsAt); const end = e.endsAt && Date.parse(e.endsAt);
    const at = { end, start, hour: start && start - 3600_000, day: start && start - 86_400_000 }[s.stopRule];
    return at ? new Date(at).toISOString() : undefined;
  }
  // The details that travel with the clip: what it is, the event, and when it stops being playable.
  const infoFor = (expires) => ({ kind: 'promo', source: 'flier', title: s.event.name, tags: ['event', 'promo'], persona: s.personaId || undefined, event: s.event, ...(expires ? { expiresAt: expires } : {}) });
  function audioCard() {
    const stop = h('select', { 'aria-label': 'Stop playing', onchange: (ev) => { s.stopRule = ev.target.value; paint(); } }, STOP.map(([v, t]) => h('option', { value: v, selected: v === s.stopRule }, t)));
    const expires = expiryFor(s.event);
    const make = h('button', { class: 'primary', type: 'button', onclick: async () => {
      make.disabled = true; say('Generating the audio...');
      try {
        s.audio = await speaker.render(s.variants[s.chosen], s.personaId ? { persona: s.personaId } : {}, { onProgress: say });
        s.audioUrl = URL.createObjectURL(s.audio.blob); s.saved = null;
        say(`Audio ready${s.audio.first.speechModel ? ` (${s.audio.first.speechModel})` : ''}. Listen, then save it.`); paint();
      } catch (err) { say(err.message, true); } finally { make.disabled = false; }
    } }, s.audio ? 'Make the audio again' : 'Make the audio');
    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try {
        const f = s.audio.first;
        const meta = { mode: 'ai', input: `flier: ${s.event.name}`, scriptText: s.audio.scriptText, voice: f.voice, provider: f.provider, speechModel: f.speechModel, tone: undefined, effects: s.audio.effects, info: infoFor(expires), handoff: false };
        s.saved = await api.request('POST', '/clips', { raw: s.audio.blob, contentType: s.audio.blob.type, headers: { 'x-clip-meta': encodeURIComponent(JSON.stringify(meta)) } });
        toast('Saved with the event details and expiry.', 'info'); say(''); paint();
      } catch (err) { say(err.message, true); save.disabled = false; }
    } }, 'Save the promo');
    return h('section', { class: 'card' }, h('h2', {}, '4. Hear it, then save'),
      h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Stop playing it', stop),
        h('div', { class: 'hint small' }, expires ? h('span', {}, h('b', {}, 'Expires: '), when(expires), ' (', s.tz, '). Nothing will play it after this, even if it is still queued or scheduled.') : h('span', { class: 'bad' }, 'No expiry: set the event\'s dates above.'))),
      h('div', { class: 'row' }, make),
      s.audio ? h('div', { class: 'clip' }, h('p', { class: 'clip-script' }, s.audio.scriptText), h('audio', { controls: true, src: s.audioUrl }), s.saved ? null : h('div', { class: 'row' }, save)) : null,
      s.saved ? afterSave(expires) : null);
  }

  // ---------- 5. after saving ----------
  function afterSave(expires) {
    const every = h('select', { 'aria-label': 'Repeat every' }, [1, 2, 3, 4, 6, 12, 24].map((n) => h('option', { value: n, selected: n === 3 }, `every ${n} hour${n > 1 ? 's' : ''}`)));
    const queueOn = options.features && options.features.stationQueue;
    const send = (play) => async (ev) => {
      ev.target.disabled = true;
      try { await api.post('/queue', { clipId: s.saved.id, play }); toast(play ? 'Queued to go on air.' : 'Queued for the station library.', 'info'); } catch (err) { toast(err.message, 'error'); } finally { ev.target.disabled = false; }
    };
    const repeat = h('button', { type: 'button', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        const minutes = Number(every.value) * 60;
        const out = await api.post('/schedules', { name: `Promo: ${s.event.name}`, when: { type: 'interval', everyMinutes: minutes, startAt: new Date().toISOString() }, content: { kind: 'clip', clipId: s.saved.id }, personaId: s.personaId, send: 'air', until: expires, info: infoFor(expires) });
        toast(`Scheduled: it will air ${every.options[every.selectedIndex].text} until ${when(expires)}.`, 'info'); void out;
      } catch (err) { toast(err.message, 'error'); } finally { ev.target.disabled = false; }
    } }, 'Repeat it until then');
    return h('div', { class: 'hint' },
      h('b', {}, 'Saved.'), ' The audio file carries the title, the event and its expiry (ID3 / WAV tags), and ', h('code', {}, `/api/clips/${s.saved.id}/meta`), ' returns them as JSON for other systems.',
      queueOn ? h('div', { class: 'row', style: 'margin-top:8px' }, h('button', { type: 'button', onclick: send(true) }, 'Send to air now'), h('button', { type: 'button', onclick: send(false) }, 'Send to station library'), h('span', { class: 'muted small' }, 'or'), every, repeat)
        : h('p', { class: 'muted small' }, 'Set STATION_MODE=queue on the site (docs/NETLIFY.md) to send promos to the station and repeat them until the event.'));
  }

  function paint() {
    clear(body, pickerCard(), s.event ? eventCard() : null, s.event ? promoCard() : null, s.event && s.variants.length ? audioCard() : null);
  }

  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h2', {}, 'Flier to promo'),
      h('p', { class: 'muted small' }, 'Turn an event flier into a promo clip in a persona\'s voice. The clip knows when the event ends and stops playing then, on its own.')),
    status, body));
  paint();
}
