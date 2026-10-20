// The whole site in one page: sign in, then three tabs. Voice Lab and Stations stay switched off until the site is connected to
// a Chips Voice server / the hub (VOICE_URL, HUB_URL and their keys), then they appear without any change here.
import { h, $, clear, toast, createClient } from './shared/kit.js';
import { mountGenerate } from './generate/generate.js';
import { mountLab } from './lab/lab.js';
import { mountPersonas } from './personas/personas.js';
import { mountLibrary } from './library/library.js';
import { mountFlier } from './flier/flier.js';
import { mountPromos } from './promos/promos.js';
import { mountSchedules } from './schedules/schedules.js';
import { mountStationProfiles } from './stations/stations.js';
import { loadStations, allStations, currentStation, setStation } from './shared/station.js';
import { mountPanel, unmountPanel } from './panel/panel.js';

const app = $('#app');
const SESSION_KEY = 'session';

const getSession = () => { try { return sessionStorage.getItem(SESSION_KEY) || ''; } catch { return ''; } };
const setSession = (value) => { try { if (value) sessionStorage.setItem(SESSION_KEY, value); else sessionStorage.removeItem(SESSION_KEY); } catch { /* storage blocked */ } };

const clientFor = (base, credential) => createClient(
  { url: `${location.origin}${base}`, headers: { authorization: `Bearer ${credential}` } },
  { onUnauthorized: () => { setSession(''); toast('Signed out. Please sign in again.', 'error'); setTimeout(() => location.reload(), 1200); } },
);

// ---------- sign in ----------
async function showLogin() {
  let methods = { passwordLogin: true, accessKey: false, disabled: false };
  try { methods = await createClient({ url: `${location.origin}/api`, headers: {} }).get('/login'); } catch { /* assume password login */ }

  return new Promise((resolve) => {
    let useKey = !methods.passwordLogin && methods.accessKey;
    const error = h('p', { class: 'bad small', role: 'alert' });
    const user = h('input', { autocomplete: 'username', 'aria-label': 'Username' });
    const pass = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Password' });
    const key = h('input', { type: 'password', autocomplete: 'off', 'aria-label': 'Access key' });
    const userBox = h('div', { class: 'grid' }, h('label', { class: 'field' }, 'Username', user), h('label', { class: 'field' }, 'Password', pass));
    const keyBox = h('label', { class: 'field' }, 'Access key', key);
    const toggle = h('button', { type: 'button', class: 'link', onclick: () => { useKey = !useKey; paint(); } });
    const go = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
    function paint() {
      userBox.hidden = useKey; keyBox.hidden = !useKey;
      toggle.textContent = useKey ? 'Use a username and password' : 'Use an access key instead';
      toggle.hidden = !(methods.passwordLogin && methods.accessKey);
    }
    paint();

    const setup = !methods.passwordLogin && !methods.accessKey && !methods.disabled;
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = ''; go.disabled = true;
      try {
        let credential;
        if (useKey) {
          credential = key.value.trim();
          await createClient({ url: `${location.origin}/api`, headers: { authorization: `Bearer ${credential}` } }).get('/options');   // proves the key works
        } else {
          credential = (await createClient({ url: `${location.origin}/api`, headers: {} }).post('/login', { username: user.value, password: pass.value })).token;
        }
        setSession(credential);
        resolve(credential);
      } catch (err) {
        error.textContent = err.status === 401 ? 'That did not work: check the details.' : err.message;
        go.disabled = false;
      }
    } }, userBox, keyBox, toggle, error, go);

    clear(app, h('div', { class: 'login' },
      h('h1', {}, 'VirtuaHost DJ'),
      h('p', { class: 'muted' }, 'Sign in to make clips and run the station.'),
      setup
        ? h('p', { class: 'bad', role: 'alert' }, 'This site has no sign-in set up yet. Set LOGIN_USERS and SESSION_SECRET (or ACCESS_KEY) in the site settings, then redeploy. See docs/NETLIFY.md.')
        : form));
  });
}

// ---------- the signed-in page ----------
function showApp(credential, options) {
  const features = options.features || {};
  const tabs = [
    { id: 'generate', label: 'Generate', on: true },
    { id: 'personas', label: 'Personas', on: true },
    { id: 'flier', label: 'Flier', on: true },
    { id: 'promos', label: 'Promos', on: true },
    { id: 'schedules', label: 'Schedules', on: true },
    { id: 'library', label: 'Library', on: true },
    { id: 'lab', label: 'Voice Lab', on: true },
    { id: 'stations', label: 'Stations', on: true },
    { id: 'control', label: 'Control', on: features.hub, needs: 'the hub', vars: 'HUB_URL and HUB_KEY',
      what: 'Control every station on one screen: now playing, skip, volume, playlists, broadcasts at the same moment, and host settings.' },
  ];
  const panel = h('div');
  let leave = () => {};
  // Other tabs can send you somewhere (for example a persona's "Use in Generate").
  window.addEventListener('vh-tab', (e) => { if (tabs.some((t) => t.id === e.detail && t.on)) select(e.detail); });

  const tabButtons = tabs.map((t) => h('button', { type: 'button', role: 'tab', onclick: () => select(t.id) }, t.label, t.on ? null : h('span', { class: 'off' }, 'off')));
  let activeTab = '';
  const select = async (id) => {
    leave(); leave = () => {};
    activeTab = id;
    tabButtons.forEach((b, i) => b.setAttribute('aria-selected', String(tabs[i].id === id)));
    const tab = tabs.find((t) => t.id === id);
    try { sessionStorage.setItem('tab', id); } catch { /* storage blocked */ }
    if (!tab.on) return clear(panel, offCard(tab));
    if (id === 'generate') await mountGenerate(panel, clientFor('/api', credential));
    if (id === 'personas') await mountPersonas(panel, clientFor('/api', credential));
    if (id === 'schedules') await mountSchedules(panel, clientFor('/api', credential));
    if (id === 'promos') await mountPromos(panel, clientFor('/api', credential));
    if (id === 'flier') await mountFlier(panel, clientFor('/api', credential));
    if (id === 'library') await mountLibrary(panel, clientFor('/api', credential));
    if (id === 'lab') await mountLab(panel, clientFor('/api', credential));
    if (id === 'stations') await mountStationProfiles(panel, clientFor('/api', credential));
    if (id === 'control') { leave = unmountPanel; await mountPanel(panel, clientFor('/api/hub', credential)); }
  };

  // The station you are working on: chosen here, used by every tab (shared/station.js).
  const stationSlot = h('span', { class: 'small muted' });
  const paintStations = () => {
    const list = allStations();
    clear(stationSlot, list.length ? h('label', { class: 'row small', title: 'The station you are working on' }, 'Station',
      h('select', { 'aria-label': 'Active station', onchange: (e) => { setStation(e.target.value); select(activeTab); } },
        list.map((s) => h('option', { value: s.id, selected: currentStation() && s.id === currentStation().id }, `${s.emoji ? `${s.emoji} ` : ''}${s.name}`)))) : options.station || '');
  };
  const api = clientFor('/api', credential);
  window.addEventListener('vh-stations', async () => { await loadStations(api); paintStations(); });

  clear(app,
    h('header', { class: 'bar' },
      h('h1', {}, 'VirtuaHost DJ'),
      h('nav', { class: 'tabs', role: 'tablist' }, tabButtons),
      h('span', { class: 'grow' }),
      stationSlot,
      h('button', { onclick: () => { setSession(''); location.reload(); } }, 'Sign out')),
    h('main', {}, panel));

  let first = 'generate';
  try { first = sessionStorage.getItem('tab') || first; } catch { /* storage blocked */ }
  // Stations load first so every tab starts with the right one.
  loadStations(api).then(() => { paintStations(); select(tabs.some((t) => t.id === first) ? first : 'generate'); });
}

function offCard(tab) {
  return h('section', { class: 'card off-card' },
    h('h2', {}, `${tab.label} is not connected yet`),
    h('p', { class: 'muted' }, tab.what),
    h('p', {}, `It needs ${tab.needs}. When you have one running:`),
    h('ol', {},
      h('li', {}, `In the site settings, set ${tab.vars}.`),
      h('li', {}, 'Redeploy the site. This tab turns on by itself.')),
    h('p', { class: 'small muted' }, 'Setup steps are in docs/HUB.md.'));
}

// ---------- start ----------
async function start() {
  let credential = getSession();
  let options = null;
  if (credential) {
    try { options = await clientFor('/api', credential).get('/options'); } catch { credential = ''; setSession(''); }
  }
  if (!options) {
    credential = await showLogin();
    options = await clientFor('/api', credential).get('/options');
  }
  showApp(credential, options);
}

start();
