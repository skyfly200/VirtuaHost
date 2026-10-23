// The whole site in one page: sign in, then the tabs, grouped in the menu. Voice Lab and Stations stay switched off until the site is connected to
// a Chips Voice server / the hub (VOICE_URL, HUB_URL and their keys), then they appear without any change here.
import { h, $, clear, toast, createClient } from './shared/kit.js';
import { mountStudio } from './studio/studio.js';
import { mountPersonas } from './personas/personas.js';
import { mountLibrary } from './library/library.js';
import { mountFlier } from './flier/flier.js';
import { mountPromos } from './promos/promos.js';
import { mountSchedules } from './schedules/schedules.js';
import { mountStationProfiles } from './stations/stations.js';
import { loadStations, allStations, currentStation, setStation } from './shared/station.js';
import { mountPanel, unmountPanel } from './panel/panel.js';
import { mountDynamic, unmountDynamic } from './dynamic/dynamic.js';
import { brand } from './shared/brand.js';
import { mountUsers, mountAccount } from './users/users.js';
import { popMenu } from './shared/popmenu.js';

const app = $('#app');
const SESSION_KEY = 'session';
// Tab ids that now open the Studio: old bookmarks, a saved sessionStorage tab, or links sent from other tabs.
const LEGACY_TABS = { generate: 'studio', lab: 'studio' };
const PHONE = '(max-width: 799px)';

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
      h('h1', {}, brand(34)),
      h('p', { class: 'muted' }, 'Sign in to make clips and run the station.'),
      setup
        ? h('p', { class: 'bad', role: 'alert' }, 'This site has no sign-in set up yet. Set SESSION_SECRET and an admin in LOGIN_USERS (or set ACCESS_KEY) in the site settings, then redeploy. See docs/NETLIFY.md.')
        : form));
  });
}

// ---------- the signed-in page ----------
const tabLabel = (t) => [t.label, t.on ? null : h('span', { class: 'off' }, 'off')];

function showApp(credential, options, me) {
  const features = options.features || {};
  const admin = me.role === 'admin';
  // `group` is the menu section a tab sits in; the groups appear in the order they first occur here.
  const tabs = [
    { id: 'studio', label: 'Studio', group: 'Create', on: true },
    { id: 'flier', label: 'Flier', group: 'Create', on: true },
    { id: 'promos', label: 'Promos', group: 'Create', on: true },
    { id: 'library', label: 'Library', group: 'Library', on: true },
    { id: 'schedules', label: 'Schedules', group: 'Plan', on: true },
    { id: 'dynamic', label: 'Dynamic', group: 'Plan', on: features.hub && admin, hidden: !admin, needs: 'the hub', vars: 'HUB_URL and HUB_KEY',
      what: 'Supervise just-in-time drops: station status and clocks, shadow review, approvals, slots, spend and the audit log.' },
    { id: 'stations', label: 'Stations', group: 'Station', on: true },
    { id: 'personas', label: 'Personas', group: 'Station', on: true },
    { id: 'control', label: 'Control', group: 'Station', on: features.hub && admin, hidden: !admin, needs: 'the hub', vars: 'HUB_URL and HUB_KEY',
      what: 'Control every station on one screen: now playing, skip, volume, playlists, broadcasts at the same moment, and host settings.' },
    // Reached from the user menu at the top right, not from the section menu.
    { id: 'account', label: 'Account', on: true, nav: false },
    { id: 'users', label: 'Users', on: admin, hidden: !admin, nav: false },
  ];
  const navTabs = tabs.filter((t) => t.nav !== false);
  const groups = [...new Set(navTabs.map((t) => t.group))];
  const panel = h('div');
  let leave = () => {};
  let activeTab = '';
  let menuOpen = false;
  const phone = matchMedia(PHONE);

  // Other tabs can send you somewhere (for example a persona's "Use in Generate"). Old ids map to the Studio.
  window.addEventListener('vh-tab', (e) => {
    const id = LEGACY_TABS[e.detail] || e.detail;
    if (tabs.some((t) => t.id === id && t.on)) select(id);
  });

  // Each tab has two buttons, one for the desktop bar and one for the phone menu; select() keeps both in step.
  const entries = navTabs.map((t) => ({
    tab: t,
    desk: h('button', { type: 'button', hidden: Boolean(t.hidden), onclick: () => { closeDrops(); select(t.id); } }, tabLabel(t)),
    drawer: h('button', { type: 'button', role: 'tab', class: 'drawer-tab', hidden: Boolean(t.hidden), onclick: () => { closeMenu(); select(t.id); } }, tabLabel(t)),
  }));
  const ofGroup = (g) => entries.filter((e) => e.tab.group === g);
  const groupHidden = (list) => list.every((e) => e.tab.hidden);

  // Desktop: one row. A group with several tabs is a dropdown button ("Create" opens Studio, Flier, Promos); a group with a single tab is just
  // that tab, so no name is ever shown twice. Click or Enter opens a dropdown; arrows move, Escape or a click elsewhere closes it.
  const visibleIn = (g) => ofGroup(g).filter((e) => !e.tab.hidden);
  const drops = [];
  const closeDrops = (except) => drops.forEach((d) => { if (d !== except) d.close(); });
  function dropdown(g) {
    const list = ofGroup(g);
    list.forEach((e) => e.desk.setAttribute('role', 'menuitem'));
    const btn = h('button', { type: 'button', class: 'menu-drop-btn', 'aria-haspopup': 'menu', 'aria-expanded': 'false' }, g, h('span', { class: 'caret', 'aria-hidden': 'true' }, '\u25BE'));
    const menu = h('div', { class: 'menu-drop', role: 'menu', 'aria-label': g, hidden: true }, list.map((e) => e.desk));
    const wrap = h('div', { class: 'menu-item menu-drop-wrap', hidden: groupHidden(list) }, btn, menu);
    const d = {
      wrap, btn, list,
      open(focusFirst) { closeDrops(d); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); if (focusFirst) visibleIn(g)[0].desk.focus(); },
      close(focusBtn) { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); if (focusBtn) btn.focus(); },
    };
    btn.addEventListener('click', () => (menu.hidden ? d.open() : d.close()));
    btn.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); d.open(true); } });
    menu.addEventListener('keydown', (e) => {
      const items = visibleIn(g).map((x) => x.desk);
      const at = items.indexOf(document.activeElement);
      const go = (i) => { e.preventDefault(); items[(i + items.length) % items.length].focus(); };
      if (e.key === 'ArrowDown') go(at + 1);
      else if (e.key === 'ArrowUp') go(at - 1);
      else if (e.key === 'Home') go(0);
      else if (e.key === 'End') go(items.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); d.close(true); }
    });
    wrap.addEventListener('focusout', (e) => { if (!wrap.contains(e.relatedTarget)) d.close(); });
    drops.push(d);
    return wrap;
  }
  const deskNav = h('nav', { class: 'tabs menu-desk', 'aria-label': 'Sections' },
    groups.map((g) => (ofGroup(g).length === 1 ? h('div', { class: 'menu-item', hidden: groupHidden(ofGroup(g)) }, ofGroup(g)[0].desk) : dropdown(g))));
  document.addEventListener('click', (e) => { if (!deskNav.contains(e.target)) closeDrops(); });

  // Phone: the same groups in a full-screen menu with large tap targets.
  const closeBtn = h('button', { type: 'button', class: 'drawer-close', onclick: () => closeMenu() }, 'Close');
  const drawer = h('div', { id: 'menu-drawer', class: 'menu-drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Menu', hidden: true },
    h('div', { class: 'drawer-head' }, h('strong', {}, 'Menu'), closeBtn),
    h('div', { class: 'drawer-body', role: 'tablist', 'aria-orientation': 'vertical', 'aria-label': 'Sections' },
      groups.map((g) => h('div', { class: 'drawer-group', hidden: groupHidden(ofGroup(g)) },
        ofGroup(g).length > 1 ? h('span', { class: 'drawer-label', role: 'presentation' }, g) : null,
        ofGroup(g).map((e) => e.drawer)))));
  const menuCurrent = h('span', { class: 'menu-current', 'aria-live': 'polite' });
  const menuBtn = h('button', { type: 'button', class: 'menu-btn', 'aria-expanded': 'false', 'aria-controls': 'menu-drawer',
    onclick: () => (menuOpen ? closeMenu() : openMenu()) }, 'Menu');

  function openMenu() {
    menuOpen = true;
    drawer.hidden = false;
    menuBtn.setAttribute('aria-expanded', 'true');
    document.body.classList.add('menu-open');
    const current = entries.find((e) => e.tab.id === activeTab);
    (current && !current.drawer.hidden ? current.drawer : closeBtn).focus();
  }
  function closeMenu({ focus = true } = {}) {
    if (!menuOpen) return;
    menuOpen = false;
    drawer.hidden = true;
    menuBtn.setAttribute('aria-expanded', 'false');
    document.body.classList.remove('menu-open');
    if (focus) menuBtn.focus();
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); closeDrops(); } });
  // Turning the window wide again closes the phone menu.
  phone.addEventListener('change', () => { if (!phone.matches) closeMenu({ focus: false }); });

  const select = async (id) => {
    leave(); leave = () => {};
    activeTab = id;
    const tab = tabs.find((t) => t.id === id);
    entries.forEach((e) => {
      const on = String(e.tab.id === id);
      if (on === 'true') e.desk.setAttribute('aria-current', 'page'); else e.desk.removeAttribute('aria-current');
      e.drawer.setAttribute('aria-selected', on);
    });
    drops.forEach((d) => d.btn.classList.toggle('has-active', d.list.some((e) => e.tab.id === id)));
    menuCurrent.textContent = tab.label;
    userBtn.classList.toggle('has-active', id === 'account' || id === 'users');
    try { sessionStorage.setItem('tab', id); } catch { /* storage blocked */ }
    if (!tab.on) return clear(panel, offCard(tab));
    if (id === 'studio') await mountStudio(panel, clientFor('/api', credential));
    if (id === 'personas') await mountPersonas(panel, clientFor('/api', credential), { admin });
    if (id === 'schedules') await mountSchedules(panel, clientFor('/api', credential));
    if (id === 'promos') await mountPromos(panel, clientFor('/api', credential));
    if (id === 'flier') await mountFlier(panel, clientFor('/api', credential));
    if (id === 'library') await mountLibrary(panel, clientFor('/api', credential));
    if (id === 'account') mountAccount(panel, clientFor('/api', credential), me);
    if (id === 'users') await mountUsers(panel, clientFor('/api', credential));
    if (id === 'stations') await mountStationProfiles(panel, clientFor('/api', credential));
    if (id === 'dynamic') { leave = unmountDynamic; await mountDynamic(panel, clientFor('/api', credential), clientFor('/api/hub', credential)); }
    if (id === 'control') { leave = unmountPanel; await mountPanel(panel, clientFor('/api/hub', credential)); }
  };

  // The station you are working on: chosen here, used by every tab (shared/station.js).
  const stationSlot = h('span', { class: 'small muted station-slot' });
  const paintStations = () => {
    const list = allStations();
    clear(stationSlot, list.length ? h('label', { class: 'row small', title: 'The station you are working on' }, 'Station',
      h('select', { 'aria-label': 'Active station', onchange: (e) => { setStation(e.target.value); select(activeTab); } },
        list.map((s) => h('option', { value: s.id, selected: currentStation() && s.id === currentStation().id }, `${s.emoji ? `${s.emoji} ` : ''}${s.name}`)))) : options.station || '');
  };
  const api = clientFor('/api', credential);
  window.addEventListener('vh-stations', async () => { await loadStations(api); paintStations(); });

  // The person at the top right: account settings, Users (admins) and sign out.
  const userMenu = popMenu({ label: `Account: ${me.username || 'you'}`, className: 'user-btn', items: () => [
    { heading: true, label: h('span', {}, h('strong', {}, me.username || 'Signed in'), me.role || '') },
    { label: 'Account settings', onclick: () => select('account') },
    { label: 'Users', hidden: !admin, onclick: () => select('users') },
    { label: 'Sign out', danger: true, onclick: () => { setSession(''); location.reload(); } },
  ] });
  const userBtn = userMenu.querySelector('button');
  userBtn.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';

  clear(app,
    h('header', { class: 'bar' },
      h('h1', { class: 'brand' }, brand(28)),
      h('div', { class: 'menu-wrap' }, menuBtn, menuCurrent),
      h('span', { class: 'grow' }),
      stationSlot,
      h('span', { class: 'user-menu' }, userMenu),
      deskNav),
    drawer,
    h('main', {}, panel));

  let first = 'studio';
  try { first = sessionStorage.getItem('tab') || first; } catch { /* storage blocked */ }
  first = LEGACY_TABS[first] || first;
  // Stations load first so every tab starts with the right one.
  loadStations(api).then(() => { paintStations(); select(tabs.some((t) => t.id === first && !t.hidden) ? first : 'studio'); });
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
  let me = { username: '', role: 'user', quota: {}, usage: null };
  try { me = await clientFor('/api', credential).get('/users/me'); } catch { /* keep the least-privileged view */ }
  showApp(credential, options, me);
}

start();
