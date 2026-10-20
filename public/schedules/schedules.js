// Schedules tab: clips that are made and sent to the station on a timetable (a station ID every hour, the morning show open at 7:30,
// an event promo every three hours until the event). The site checks every minute; with STATION_MODE=queue each run goes to the
// station daemon. A schedule with an end date never runs after it, and the clips it makes expire then (docs/CLIP-METADATA.md).
import { h, clear, toast } from '../shared/kit.js';
import { allStations, currentStation, stationId } from '../shared/station.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const at = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const ago = (iso) => { const m = Math.round((Date.parse(iso) - Date.now()) / 60000); return m <= 0 ? 'due now' : m < 60 ? `in ${m} min` : m < 1440 ? `in ${Math.round(m / 60)} h` : `in ${Math.round(m / 1440)} d`; };

function whenText(w) {
  if (w.type === 'once') return `Once, ${at(w.at)}`;
  if (w.type === 'interval') return w.everyMinutes % 60 === 0 ? `Every ${w.everyMinutes / 60} hour${w.everyMinutes === 60 ? '' : 's'}` : `Every ${w.everyMinutes} minutes`;
  return `Daily at ${w.time} (${w.tz})${w.days.length ? `, ${w.days.map((d) => DAYS[d]).join(' ')}` : ''}`;
}
const contentText = (c) => (c.kind === 'text' ? `Says: "${c.text.slice(0, 90)}"` : c.kind === 'ai' ? `AI brief: "${c.prompt.slice(0, 90)}"` : 'A saved clip');

export async function mountSchedules(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let schedules = []; let personas = []; let clips = []; let options; let fxPresets = [];
  try {
    [{ schedules }, options] = await Promise.all([api.get('/schedules'), api.get('/options')]);
    personas = (await api.get('/personas').catch(() => ({ personas: [] }))).personas;
    clips = (await api.get('/clips').catch(() => ({ clips: [] }))).clips;
    fxPresets = ((await api.get('/host').catch(() => ({}))).fxPresets || []).filter((f) => f !== 'none');
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load schedules: ${err.message}`)); return; }

  const queueOn = Boolean(options.features && options.features.stationQueue);
  const listBox = h('div', { class: 'stack' });
  const reload = async () => { schedules = (await api.get('/schedules')).schedules; paintList(); };

  // ---------- the list ----------
  function paintList() {
    clear(listBox, schedules.length ? schedules.map((s) => h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, s.enabled ? 'on' : 'off'), h('span', { class: 'chip' }, s.send === 'air' ? 'goes on air' : s.send === 'library' ? 'station library' : 'saved only'),
        s.stationId ? h('span', { class: 'chip' }, (allStations().find((x) => x.id === s.stationId) || { name: s.stationId }).name) : null,
        s.until ? h('span', { class: 'chip', title: s.until }, `ends ${at(s.until)}`) : null, s.info && s.info.kind ? h('span', { class: 'chip' }, s.info.kind) : null),
      h('strong', {}, s.name),
      h('p', { class: 'small' }, `${whenText(s.when)} · ${contentText(s.content)}`),
      h('p', { class: 'small muted' }, s.nextAt ? `Next: ${at(s.nextAt)} (${ago(s.nextAt)})` : 'Finished', ` · ran ${s.runs} time${s.runs === 1 ? '' : 's'}`, s.lastRunAt ? ` · last ${at(s.lastRunAt)}: ${s.lastResult}` : s.lastResult ? ` · ${s.lastResult}` : ''),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: async (e) => { e.currentTarget.disabled = true; try { await api.put(`/schedules/${s.id}`, { enabled: !s.enabled }); await reload(); } catch (err) { toast(err.message, 'error'); } } }, s.enabled ? 'Turn off' : 'Turn on'),
        h('button', { type: 'button', onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { const out = await api.post(`/schedules/${s.id}/run`, {}); toast(`Ran: ${out.result}`, 'info'); await reload(); } catch (err) { toast(err.message, 'error'); b.disabled = false; } } }, 'Run now'),
        h('button', { type: 'button', class: 'link danger', onclick: async () => { if (!confirm(`Delete "${s.name}"?`)) return; try { await api.del(`/schedules/${s.id}`); await reload(); } catch (err) { toast(err.message, 'error'); } } }, 'Delete'))))
      : h('p', { class: 'empty' }, 'No schedules yet. Make one below.'));
  }

  // ---------- the form ----------
  const f = { name: '', kind: 'text', text: '', prompt: '', clipId: clips[0] ? clips[0].id : '', type: 'daily', onceAt: '', everyN: 1, unit: 'hours', time: '07:30', days: [], tz: (currentStation() && currentStation().tz) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', personaId: (currentStation() && currentStation().defaultPersonaId) || '', send: queueOn ? 'air' : 'none', preempt: false, fx: (currentStation() && currentStation().defaultFx) || '', until: '', count: 0 };
  const formBox = h('section', { class: 'card' });
  function paintForm() {
    const field = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { ...props, value: f[key], oninput: (e) => { f[key] = props.type === 'number' ? Number(e.target.value) : e.target.value; } }));
    const select = (label, key, pairs, after) => h('label', { class: 'field' }, label, h('select', { onchange: (e) => { f[key] = e.target.value; if (after) after(); } }, pairs.map(([v, t]) => h('option', { value: v, selected: String(v) === String(f[key]) }, t))));
    const content = f.kind === 'text' ? h('label', { class: 'field' }, 'What to say', Object.assign(h('textarea', { rows: 3, oninput: (e) => { f.text = e.target.value; } }), { value: f.text }))
      : f.kind === 'ai' ? h('label', { class: 'field' }, 'Brief for the AI (it writes a fresh line each time)', Object.assign(h('textarea', { rows: 3, placeholder: 'a friendly top-of-the-hour station ID', oninput: (e) => { f.prompt = e.target.value; } }), { value: f.prompt }))
        : select('Clip', 'clipId', clips.length ? clips.map((c) => [c.id, `${c.scriptText.slice(0, 60)}${c.info && c.info.expiresAt && Date.parse(c.info.expiresAt) <= Date.now() ? ' (expired)' : ''}`]) : [['', 'No saved clips yet']]);
    const when = f.type === 'once' ? field('Date and time', 'onceAt', { type: 'datetime-local' })
      : f.type === 'interval' ? h('div', { class: 'grid cols' }, field('Every', 'everyN', { type: 'number', min: 1 }), select('', 'unit', [['minutes', 'minutes'], ['hours', 'hours'], ['days', 'days']]))
        : h('div', { class: 'grid' }, h('div', { class: 'grid cols' }, field('At', 'time', { type: 'time' }), field('Time zone', 'tz')),
          h('div', { class: 'row' }, h('span', { class: 'small muted' }, 'On (none ticked = every day):'), DAYS.map((d, i) => h('label', { class: 'row small' }, h('input', { type: 'checkbox', checked: f.days.includes(i), onchange: (e) => { f.days = e.target.checked ? [...f.days, i] : f.days.filter((x) => x !== i); } }), d))));
    const submit = h('button', { class: 'primary', type: 'button', onclick: async () => {
      submit.disabled = true;
      try {
        const minutes = f.unit === 'days' ? f.everyN * 1440 : f.unit === 'hours' ? f.everyN * 60 : f.everyN;
        const whenBody = f.type === 'once' ? { type: 'once', at: f.onceAt ? new Date(f.onceAt).toISOString() : '' }
          : f.type === 'interval' ? { type: 'interval', everyMinutes: minutes, startAt: new Date().toISOString() } : { type: 'daily', time: f.time, days: f.days, tz: f.tz };
        const contentBody = f.kind === 'text' ? { kind: 'text', text: f.text } : f.kind === 'ai' ? { kind: 'ai', prompt: f.prompt } : { kind: 'clip', clipId: f.clipId };
        await api.post('/schedules', { name: f.name, when: whenBody, content: contentBody, personaId: f.personaId, send: f.send, preempt: f.preempt, fx: f.fx, count: f.count, stationId: stationId() || undefined, ...(f.until ? { until: new Date(f.until).toISOString() } : {}) });
        toast('Schedule created.', 'info'); await reload();
      } catch (err) { toast(err.message, 'error'); } finally { submit.disabled = false; }
    } }, 'Create schedule');
    clear(formBox, h('h2', {}, 'New schedule'),
      !queueOn ? h('p', { class: 'note warn small' }, 'Sending to the station needs STATION_MODE=queue on the site (docs/NETLIFY.md). Until then a schedule only makes and saves the clips.') : null,
      h('div', { class: 'grid' },
        field('Name', 'name', { placeholder: 'e.g. Top of the hour ID' }),
        select('What it plays', 'kind', [['text', 'Words I write'], ['ai', 'Words the AI writes each time'], ['clip', 'A saved clip']], paintForm), content,
        select('When', 'type', [['daily', 'Every day at a time'], ['interval', 'Every so often'], ['once', 'Once']], paintForm), when,
        h('div', { class: 'grid cols' },
          select('Persona', 'personaId', [['', 'None'], ...personas.map((p) => [p.id, `${p.emoji || ''} ${p.name}`.trim()])]),
          select('Send', 'send', [['air', 'Put it on air'], ['library', 'Station library only'], ['none', 'Just save the clip']]),
          fxPresets.length ? select('Audio treatment', 'fx', [['', 'None'], ...fxPresets.map((x) => [x, x])]) : null),
        h('div', { class: 'grid cols' }, field('Stop after (optional)', 'until', { type: 'datetime-local' }), field('Or after this many runs (0 = no limit)', 'count', { type: 'number', min: 0 }),
          h('label', { class: 'row' }, h('input', { type: 'checkbox', checked: f.preempt, onchange: (e) => { f.preempt = e.target.checked; } }), 'May cut in over a live DJ')),
        h('p', { class: 'muted small' }, 'An end date also makes every clip it creates expire then, so nothing plays after the event.')),
      h('div', { class: 'row' }, submit));
  }

  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' }, h('h2', {}, 'Schedules'), h('p', { class: 'muted small' }, 'Things that happen by themselves. The site checks every minute.'), listBox), formBox));
  paintList(); paintForm();
}
