// The Library's Clips list: everything saved on the site (generated, mixed, flier promos, host links), searchable and filterable, each
// with a play button and the details that travel with it. Edit a title or expiry, send it to the station, or delete it.
import { h, clear } from '../shared/kit.js';
import { clipCard, isExpired, stationLabel } from '../shared/clipcard.js';
import { currentStation } from '../shared/station.js';

const PAGE = 40;

export async function mountClips(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading clips...'));
  let clips = []; let personas = []; let queueOn = false;
  try {
    [{ clips }, { personas }] = await Promise.all([api.get('/clips'), api.get('/personas').catch(() => ({ personas: [] }))]);
    queueOn = Boolean(((await api.get('/options').catch(() => ({}))).features || {}).stationQueue);
  } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load clips: ${err.message}`)); return; }

  const f = { search: '', kind: '', scope: currentStation() && !currentStation().builtin ? 'this' : 'all', status: 'all', shown: PAGE };
  const listBox = h('div', { class: 'stack' });
  const countBox = h('p', { class: 'small muted', role: 'status' });
  const reload = async () => { clips = (await api.get('/clips')).clips; paint(); };

  function visible() {
    const q = f.search.trim().toLowerCase();
    const active = currentStation();
    return clips.filter((c) => {
      const info = c.info || {};
      if (f.kind && (info.kind || 'other') !== f.kind) return false;
      if (f.scope === 'this' && active && !active.builtin && info.station !== active.id) return false;
      if (f.status === 'expired' && !isExpired(c)) return false;
      if (f.status === 'active' && isExpired(c)) return false;
      if (q && ![c.scriptText, info.title, info.kind, (info.tags || []).join(' '), info.event && info.event.name, c.voice, c.speechModel, stationLabel(info.station)].join(' ').toLowerCase().includes(q)) return false;
      return true;
    });
  }

  function paint() {
    const list = visible();
    const expiredCount = clips.filter((c) => isExpired(c)).length;
    clear(countBox, `${list.length} of ${clips.length} clip${clips.length === 1 ? '' : 's'}${expiredCount ? ` · ${expiredCount} expired` : ''}`);
    clear(listBox, list.length ? [...list.slice(0, f.shown).map((c) => clipCard(c, { api, queueOn, personas, onChange: reload })),
      list.length > f.shown ? h('button', { type: 'button', onclick: () => { f.shown += PAGE; paint(); } }, `Show ${Math.min(PAGE, list.length - f.shown)} more`) : null]
      : h('p', { class: 'empty' }, clips.length ? 'No clips match. Try clearing the filters.' : 'No clips saved yet. Make one in the Generate tab.'));
  }

  const kinds = [...new Set(clips.map((c) => (c.info && c.info.kind) || 'other'))].sort();
  const station = currentStation();
  clear(root, h('div', { class: 'stack' },
    h('div', { class: 'grid cols' },
      h('input', { type: 'search', placeholder: 'Search clips...', 'aria-label': 'Search clips', oninput: (e) => { f.search = e.target.value; f.shown = PAGE; paint(); } }),
      h('select', { 'aria-label': 'Kind', onchange: (e) => { f.kind = e.target.value; f.shown = PAGE; paint(); } }, h('option', { value: '' }, 'All kinds'), kinds.map((k) => h('option', { value: k }, k))),
      h('select', { 'aria-label': 'Status', onchange: (e) => { f.status = e.target.value; f.shown = PAGE; paint(); } }, [['all', 'Any status'], ['active', 'Can still play'], ['expired', 'Expired']].map(([v, t]) => h('option', { value: v }, t))),
      station && !station.builtin ? h('select', { 'aria-label': 'Station', onchange: (e) => { f.scope = e.target.value; f.shown = PAGE; paint(); } }, [['this', `Only ${station.name}`], ['all', 'All stations']].map(([v, t]) => h('option', { value: v, selected: v === f.scope }, t))) : null),
    countBox, listBox));
  paint();
}
