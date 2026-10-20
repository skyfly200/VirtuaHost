// Promos page: every promo clip (made from a flier, or any clip marked "promo"), what it is for, whether it can still play, and what
// repeats it. A promo carries its event and an expiry (docs/CLIP-METADATA.md), so one stops airing on its own when the event is over;
// here you can hear it, send it, repeat it until then, move the end, or delete it.
import { h, clear, toast } from '../shared/kit.js';
import { clipCard, isExpired, stationLabel } from '../shared/clipcard.js';
import { currentStation } from '../shared/station.js';

const goTo = (tab) => window.dispatchEvent(new CustomEvent('vh-tab', { detail: tab }));

export async function mountPromos(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading promos...'));
  let clips = []; let schedules = []; let personas = []; let queueOn = false;
  const load = async () => {
    [{ clips }, { schedules }] = await Promise.all([api.get('/clips'), api.get('/schedules').catch(() => ({ schedules: [] }))]);
  };
  try {
    await load();
    personas = (await api.get('/personas').catch(() => ({ personas: [] }))).personas;
    queueOn = Boolean(((await api.get('/options').catch(() => ({}))).features || {}).stationQueue);
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load promos: ${err.message}`)); return; }

  const f = { search: '', status: 'active', scope: currentStation() && !currentStation().builtin ? 'this' : 'all' };
  const tz = () => (currentStation() && currentStation().tz) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const when = (iso) => { try { return new Intl.DateTimeFormat([], { timeZone: tz(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso)); } catch { return iso; } };
  const hours = (m) => (m % 60 === 0 ? `${m / 60} hour${m === 60 ? '' : 's'}` : `${m} minutes`);
  const reload = async () => { await load(); paint(); };

  const isPromo = (c) => (c.info && c.info.kind === 'promo') || Boolean(c.info && c.info.event);
  const mySchedules = (clip) => schedules.filter((s) => s.content && s.content.kind === 'clip' && s.content.clipId === clip.id);

  // What the event is, whether it is on yet, and when the promo stops: the extra part of a promo's card.
  function extra(clip) {
    const e = (clip.info && clip.info.event) || {};
    const now = Date.now();
    const start = e.startsAt && Date.parse(e.startsAt); const end = e.endsAt && Date.parse(e.endsAt);
    const state = !start ? '' : end && now > end ? 'The event is over' : start <= now ? 'Happening now' : (() => { const d = Math.ceil((start - now) / 86_400_000); return d <= 1 ? 'Starts within a day' : `Starts in ${d} days`; })();
    const linked = mySchedules(clip);
    const every = h('select', { 'aria-label': 'Repeat every' }, [1, 2, 3, 4, 6, 12, 24].map((n) => h('option', { value: n, selected: n === 3 }, `every ${n} hour${n > 1 ? 's' : ''}`)));
    const repeat = h('button', { type: 'button', onclick: async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api.post('/schedules', { name: `Promo: ${(clip.info && clip.info.title) || e.name || clip.scriptText.slice(0, 40)}`, when: { type: 'interval', everyMinutes: Number(every.value) * 60, startAt: new Date().toISOString() }, content: { kind: 'clip', clipId: clip.id }, personaId: (clip.info && clip.info.persona) || '', send: 'air', until: clip.info.expiresAt, info: clip.info, stationId: (clip.info && clip.info.station) || undefined });
        toast(`Scheduled: every ${every.value} hour${every.value === '1' ? '' : 's'} until ${when(clip.info.expiresAt)}.`, 'info'); await reload();
      } catch (err) { toast(err.message, 'error'); ev.currentTarget.disabled = false; }
    } }, 'Repeat until then');
    return h('div', { class: 'stack small' },
      e.name ? h('div', {}, '📅 ', h('b', {}, e.name), start ? ` · ${when(e.startsAt)}${end ? ` to ${new Intl.DateTimeFormat([], { timeZone: tz(), hour: 'numeric', minute: '2-digit' }).format(new Date(end))}` : ''}` : '', e.venue ? ` · ${e.venue}` : '', e.price ? ` · ${e.price}` : '', state ? h('span', { class: 'chip', style: 'margin-left:6px' }, state) : null) : null,
      linked.map((s) => h('div', { class: 'row' }, h('span', { class: 'chip' }, s.enabled ? 'repeating' : 'repeat off'), h('span', { class: 'muted' }, `${s.when.type === 'interval' ? `every ${hours(s.when.everyMinutes)}` : 'scheduled'}${s.until ? ` until ${when(s.until)}` : ''}${s.nextAt ? ` · next ${when(s.nextAt)}` : ''}${s.lastResult ? ` · last: ${s.lastResult}` : ''}`),
        h('button', { type: 'button', class: 'link', onclick: async () => { try { await api.put(`/schedules/${s.id}`, { enabled: !s.enabled }); await reload(); } catch (err) { toast(err.message, 'error'); } } }, s.enabled ? 'Turn off' : 'Turn on'),
        h('button', { type: 'button', class: 'link danger', onclick: async () => { try { await api.del(`/schedules/${s.id}`); await reload(); } catch (err) { toast(err.message, 'error'); } } }, 'Remove'))),
      !isExpired(clip) && clip.info && clip.info.expiresAt && !linked.length ? h('div', { class: 'row' }, every, repeat, h('span', { class: 'muted' }, `then it stops by itself at ${when(clip.info.expiresAt)}`)) : null,
      !clip.info || !clip.info.expiresAt ? h('div', { class: 'note warn' }, 'This promo has no expiry, so it would keep playing after the event. Use "Edit details" to set one.') : null);
  }

  const listBox = h('div', { class: 'stack' });
  const countBox = h('p', { class: 'small muted', role: 'status' });
  function visible() {
    const q = f.search.trim().toLowerCase();
    const active = currentStation();
    return clips.filter(isPromo).filter((c) => {
      const info = c.info || {};
      if (f.scope === 'this' && active && !active.builtin && info.station !== active.id) return false;
      if (f.status === 'active' && isExpired(c)) return false;
      if (f.status === 'expired' && !isExpired(c)) return false;
      if (q && ![c.scriptText, info.title, info.event && info.event.name, info.event && info.event.venue, stationLabel(info.station)].join(' ').toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      // the soonest event first; promos with no date last
      const at = (c) => Date.parse((c.info.event && c.info.event.startsAt) || c.info.expiresAt || '') || Infinity;
      return f.status === 'expired' ? at(b) - at(a) : at(a) - at(b);
    });
  }
  function paint() {
    const all = clips.filter(isPromo);
    const list = visible();
    const live = all.filter((c) => !isExpired(c)).length;
    clear(countBox, `${list.length} shown · ${live} can still play · ${all.length - live} expired`);
    clear(listBox, list.length ? list.map((c) => clipCard(c, { api, queueOn, personas, onChange: reload, extra })) : h('p', { class: 'empty' }, all.length ? 'No promos match.' : 'No promos yet. Make one from an event flier.'));
  }

  const station = currentStation();
  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('div', { class: 'row' }, h('h2', { class: 'grow' }, 'Promos'), h('button', { class: 'primary', type: 'button', onclick: () => goTo('flier') }, 'New promo from a flier')),
      h('p', { class: 'muted small' }, 'Promo clips for events. Each one knows when its event ends and stops playing then, on its own: the site will not queue or schedule it, and the station will not play it.'),
      h('div', { class: 'grid cols' },
        h('input', { type: 'search', placeholder: 'Search promos...', 'aria-label': 'Search promos', oninput: (e) => { f.search = e.target.value; paint(); } }),
        h('select', { 'aria-label': 'Status', onchange: (e) => { f.status = e.target.value; paint(); } }, [['active', 'Can still play'], ['expired', 'Expired'], ['all', 'All']].map(([v, t]) => h('option', { value: v, selected: v === f.status }, t))),
        station && !station.builtin ? h('select', { 'aria-label': 'Station', onchange: (e) => { f.scope = e.target.value; paint(); } }, [['this', `Only ${station.name}`], ['all', 'All stations']].map(([v, t]) => h('option', { value: v, selected: v === f.scope }, t))) : null),
      countBox),
    listBox));
  paint();
}
