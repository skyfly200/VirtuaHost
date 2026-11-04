// Set or remove an AI provider key (OpenRouter or Gemini) for yourself, or for a station (admins). A saved key is never shown again:
// only that one is set and its last four characters. Your own key is used for your requests and does not use up your AI limits.
import { h, clear, toast } from './kit.js';

const NAMES = { openrouter: 'OpenRouter', gemini: 'Google (Gemini)', elevenlabs: 'ElevenLabs (voice clones)' };
const BLURBS = {
  openrouter: 'Your own OpenRouter key writes the lines and speaks them with OpenRouter models, billed to you. It replaces the site\'s key for your requests and does not count toward your limits.',
  gemini: 'Your own Google AI (Gemini) key is used when the Google provider is chosen, billed to you, instead of the site\'s key. It does not count toward your limits.',
  elevenlabs: 'An ElevenLabs key lets you speak in your cloned voices. The words are still written by OpenRouter or Google.',
};

// With `provider`, this is one provider's own section (used by Account settings); without it, the combined picker (stations).
export function keyBox(api, { station, provider: only } = {}) {
  const box = h('div', { class: 'stack' });
  const q = station ? `?station=${encodeURIComponent(station)}` : '';
  const provider = h('select', { 'aria-label': 'Provider' }, Object.entries(NAMES).map(([v, t]) => h('option', { value: v }, t)));
  const input = h('input', { type: 'password', autocomplete: 'off', placeholder: 'Paste the API key', 'aria-label': 'API key' });

  async function paint() {
    let info;
    try { info = await api.get(`/keys${q}`); } catch (err) { clear(box, h('p', { class: 'bad small' }, err.message)); return; }
    const have = station ? info.station : info.user;
    if (station && !have) { box.hidden = true; return; }       // only admins get to see or change a station's key
    box.hidden = false;
    const rows = Object.entries(have).filter(([p]) => !only || p === only).map(([p, k]) => h('div', { class: 'row small' },
      h('span', {}, `${NAMES[p]} key set (ends ${k.last4})`),
      h('button', { type: 'button', class: 'link danger', onclick: async () => {
        try { await api.del(`/keys?provider=${p}${station ? `&station=${encodeURIComponent(station)}` : ''}`); await paint(); } catch (err) { toast(err.message, 'error'); }
      } }, 'Remove')));
    clear(box,
      h('h3', {}, only ? `${NAMES[only]} key` : station ? 'AI key for this station' : 'My AI key'),
      h('p', { class: 'small muted' }, only ? BLURBS[only] : station
        ? 'Used for requests made for this station when the person has no key of their own. Without one, the site\'s key is used.'
        : 'Use your own OpenRouter or Gemini key so your requests are billed to you and do not count toward your limits, or add an ElevenLabs key to speak in your cloned voices. Without a key, the site\'s is used.'),
      info.storage ? null : h('p', { class: 'bad small' }, 'Keys cannot be stored yet: the site needs SECRETS_KEY (or SESSION_SECRET) set.'),
      rows,
      h('div', { class: 'grid cols' }, only ? null : h('label', { class: 'field' }, 'Provider', provider), h('label', { class: 'field' }, only && Object.keys(have).includes(only) ? 'Replace key' : 'Key', input),
        h('button', { type: 'button', onclick: async () => {
          try { await api.request('PUT', '/keys', { body: { provider: only || provider.value, key: input.value, ...(station ? { station } : {}) } }); input.value = ''; toast('Key saved', 'info'); await paint(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Save key')));
  }
  paint();
  return box;
}
