// One saved clip as a card: a play button, what it says, its details (kind, station, persona, voice and model, expiry), and what you can
// do with it: send it to the station, change its details or expiry, delete it. Shared by the Library's Clips list and the Promos page.
import { h, clear, toast, fmtDate, audioUrl } from './kit.js';
import { createPlayer } from './playbutton.js';
import { allStations } from './station.js';

export const isExpired = (clip, now = Date.now()) => Boolean(clip.info && clip.info.expiresAt && Date.parse(clip.info.expiresAt) <= now);
export const stationLabel = (id) => { if (!id) return ''; const s = allStations().find((x) => x.id === id); return s ? `${s.emoji ? `${s.emoji} ` : ''}${s.name}` : id; };

const localInput = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };

// ctx: { api, queueOn, personas?, onChange(), extra?(clip) -> element, actions?(clip) -> [elements] }
export function clipCard(clip, ctx) {
  const { api } = ctx;
  const info = clip.info || {};
  const expired = isExpired(clip);
  const player = createPlayer({ label: 'Play this clip', load: () => audioUrl(api, `/clips/${encodeURIComponent(clip.id)}`) });
  const body = h('div', { class: 'grow' });
  const card = h('div', { class: 'clip', style: expired ? 'opacity:.7' : '' });

  const chips = [
    info.kind ? h('span', { class: 'chip' }, info.kind) : null,
    info.station ? h('span', { class: 'chip' }, stationLabel(info.station)) : null,
    info.persona ? h('span', { class: 'chip' }, `🎭 ${(ctx.personas || []).find((p) => p.id === info.persona)?.name || info.persona}`) : null,
    clip.speechModel ? h('span', { class: 'chip', title: 'Speech model' }, `🔊 ${clip.speechModel}${clip.voice ? ` · ${clip.voice}` : ''}`) : null,
    clip.textModel ? h('span', { class: 'chip', title: 'Writing model' }, `✍ ${clip.textModel}`) : null,
    clip.tone ? h('span', { class: 'chip' }, clip.tone) : null,
    info.expiresAt ? h('span', { class: 'chip', title: info.expiresAt, style: expired ? 'text-decoration:line-through' : '' }, expired ? 'expired' : `expires ${fmtDate(Date.parse(info.expiresAt))}`) : null,
    ...(info.tags || []).map((t) => h('span', { class: 'chip' }, `#${t}`)),
  ];

  function paint() {
    clear(body,
      h('div', { class: 'row small muted' }, h('strong', { style: 'color:var(--ink)' }, info.title || clip.scriptText.slice(0, 60)), h('span', {}, fmtDate(Date.parse(clip.createdAt))), chips),
      h('p', { class: 'clip-script' }, clip.scriptText),
      ctx.extra ? ctx.extra(clip) : null,
      h('div', { class: 'row' },
        ...(!expired && ctx.queueOn ? [
          h('button', { type: 'button', onclick: send(true) }, 'Send to air'),
          h('button', { type: 'button', onclick: send(false) }, 'Send to station library')] : []),
        h('button', { type: 'button', onclick: () => editing() }, 'Edit details'),
        ...(ctx.actions ? ctx.actions(clip) : []),
        h('button', { type: 'button', class: 'link danger', onclick: remove }, 'Delete')));
  }

  const send = (play) => async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await api.post('/queue', { clipId: clip.id, play }); toast(play ? 'Queued to go on air.' : 'Queued for the station library.', 'info'); } catch (err) { toast(err.message, 'error'); } finally { b.disabled = false; }
  };
  async function remove() {
    if (!confirm('Delete this clip? Its audio is removed and schedules that use it will fail.')) return;
    try { player.stop(); await api.del(`/clips/${encodeURIComponent(clip.id)}`); toast('Deleted.', 'info'); ctx.onChange(); } catch (err) { toast(err.message, 'error'); }
  }
  function editing(state) {
    const f = state || { title: info.title || '', kind: info.kind || '', tags: (info.tags || []).join(', '), expires: localInput(info.expiresAt) };
    const input = (label, key, props = {}) => h('label', { class: 'field' }, label, h('input', { ...props, value: f[key], oninput: (e) => { f[key] = e.target.value; } }));
    const save = h('button', { class: 'primary', type: 'button', onclick: async () => {
      save.disabled = true;
      try {
        await api.request('PATCH', `/clips/${encodeURIComponent(clip.id)}`, { body: { title: f.title, kind: f.kind, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean), expiresAt: f.expires ? new Date(f.expires).toISOString() : null } });
        toast('Details saved (the audio file\'s tags were rewritten).', 'info'); ctx.onChange();
      } catch (err) { toast(err.message, 'error'); save.disabled = false; }
    } }, 'Save');
    clear(body, h('div', { class: 'grid' },
      h('div', { class: 'grid cols' }, input('Title', 'title'), input('Kind', 'kind', { placeholder: 'promo, station-id, drop...' }), input('Tags (comma separated)', 'tags')),
      h('div', { class: 'grid cols' }, input('Do not play after (blank = never expires)', 'expires', { type: 'datetime-local' }),
        h('div', { class: 'row', style: 'align-self:end' }, h('button', { type: 'button', onclick: () => { f.expires = ''; editing(f); } }, 'Remove the expiry'),
          h('button', { type: 'button', onclick: () => { f.expires = localInput(new Date(Date.now() + 86_400_000).toISOString()); editing(f); } }, 'Extend a day from now'))),
      h('div', { class: 'row' }, save, h('button', { type: 'button', onclick: paint }, 'Cancel'))));
  }

  paint();
  clear(card, h('div', { class: 'row', style: 'align-items:flex-start;flex-wrap:nowrap' }, player.button, body));
  return card;
}
