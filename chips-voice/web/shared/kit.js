// Shared by the Voice Lab and the Control Panel: element helper, a small API client with sign-in, toasts, and the connect dialog.
// No build step and no dependencies: plain ES modules, so this folder can be deployed as-is to Netlify, Vercel, or the hub itself.

// h('div', { class: 'card', onclick: fn }, 'text', child) -> element. Text is always set as text, never as HTML.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const $ = (sel, root = document) => root.querySelector(sel);
export function clear(el, ...children) { el.replaceChildren(...children.flat().filter(Boolean)); return el; }

export function toast(message, type = 'info') {
  let box = $('#toasts');
  if (!box) { box = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
  const t = h('div', { class: `toast ${type}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 7000 : 3500);
}

const safe = (fn, fallback) => { try { return fn(); } catch (err) { return fallback; } };

// Remembered sign-in per app. The long-lived secret is kept for the tab only unless "remember" is ticked; tokens are what is stored.
function loadSession(id) {
  return safe(() => JSON.parse(sessionStorage.getItem(`session:${id}`) || localStorage.getItem(`session:${id}`) || 'null'), null);
}
function saveSession(id, session, remember) {
  safe(() => { sessionStorage.removeItem(`session:${id}`); localStorage.removeItem(`session:${id}`); });
  if (session) safe(() => (remember ? localStorage : sessionStorage).setItem(`session:${id}`, JSON.stringify(session)));
}
export const lastUrl = (id) => safe(() => localStorage.getItem(`url:${id}`) || '', '');

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// A client for one backend. `session` = { url, authHeader }.
export function createClient(session, { onUnauthorized } = {}) {
  async function request(method, path, { body, raw, query, blob, contentType, signal } = {}) {
    const url = new URL(path.replace(/^\//, ''), session.url.endsWith('/') ? session.url : `${session.url}/`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = { ...session.headers };
    let payload;
    if (raw) { payload = raw; headers['content-type'] = contentType || raw.type || 'application/octet-stream'; } else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, { method, headers, body: payload, signal }); } catch (err) {
      throw new ApiError(`Cannot reach ${session.url} (${err.message}). Check the address, that it is running, and its CORS setting.`, 0);
    }
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j && j.error) message = j.error; } catch (err) { /* keep status text */ }
      throw new ApiError(message, res.status);
    }
    if (blob) return res.blob();
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
  return {
    url: session.url, request,
    get: (p, o) => request('GET', p, o), post: (p, body, o) => request('POST', p, { ...o, body }),
    put: (p, body, o) => request('PUT', p, { ...o, body }), del: (p, o) => request('DELETE', p, o),
  };
}

// Shows the sign-in dialog until it works. kind 'hub' signs in with a key; kind 'voice' with an API key or a username and password.
// Resolves with a client; calling client.signOut() forgets the session.
export async function connect({ id, label, kind }) {
  let remembered = loadSession(id);
  const make = (session) => {
    const client = createClient(session, { onUnauthorized: () => { saveSession(id, null); toast('Signed out, please sign in again', 'error'); setTimeout(() => location.reload(), 1200); } });
    client.signOut = () => { saveSession(id, null); location.reload(); };
    client.label = label;
    return client;
  };
  if (remembered) {
    try { const c = make(remembered); await c.get(kind === 'hub' ? '/stations' : '/providers'); return c; } catch (err) { if (err.status === 401 || err.status === 0) remembered = null; else return make(remembered); }
  }
  return new Promise((resolve) => {
    const url = h('input', { type: 'url', placeholder: 'https://your-server.example.com', value: lastUrl(id), required: true, autocomplete: 'url' });
    const key = h('input', { type: 'password', placeholder: kind === 'hub' ? 'Hub key' : 'API key', autocomplete: 'current-password' });
    const user = h('input', { type: 'text', placeholder: 'Username', autocomplete: 'username' });
    const pass = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
    const remember = h('input', { type: 'checkbox' });
    const error = h('p', { class: 'bad small', role: 'alert' });
    const go = h('button', { class: 'primary', type: 'submit' }, 'Connect');
    let mode = 'key';
    const userBox = h('div', { class: 'grid', hidden: true }, h('label', { class: 'field' }, 'Username', user), h('label', { class: 'field' }, 'Password', pass));
    const keyBox = h('label', { class: 'field' }, kind === 'hub' ? 'Hub key' : 'API key', key);
    const toggle = h('button', { class: 'link', type: 'button', onclick: () => { mode = mode === 'key' ? 'user' : 'key'; userBox.hidden = mode !== 'user'; keyBox.hidden = mode !== 'key'; toggle.textContent = mode === 'key' ? 'Use username and password instead' : 'Use a key instead'; } }, 'Use username and password instead');
    const form = h('form', { method: 'dialog', class: 'grid', onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = ''; go.disabled = true; go.textContent = 'Connecting...';
      const base = url.value.trim().replace(/\/+$/, '');
      try {
        let session;
        if (kind === 'hub' || mode === 'user') {
          const probe = createClient({ url: base, headers: {} });
          const out = await probe.post('/auth/login', kind === 'hub' ? { key: key.value } : { username: user.value, password: pass.value });
          session = { url: base, headers: { authorization: `Bearer ${out.token}` } };
        } else {
          session = { url: base, headers: { 'x-api-key': key.value } };
        }
        const client = make(session);
        await client.get(kind === 'hub' ? '/stations' : '/providers');
        safe(() => localStorage.setItem(`url:${id}`, base));
        saveSession(id, session, remember.checked);
        dialog.close(); dialog.remove();
        resolve(client);
      } catch (err) {
        error.textContent = err.status === 401 ? 'That did not work: check the key or password.' : err.message;
        go.disabled = false; go.textContent = 'Connect';
      }
    } },
    h('h2', {}, `Connect to ${label}`),
    h('label', { class: 'field' }, 'Server address', url), keyBox, userBox,
    kind === 'voice' ? toggle : null,
    h('label', { class: 'row small muted' }, remember, 'Keep me signed in on this device'),
    error, h('div', { class: 'row end' }, go));
    const dialog = h('dialog', {}, form);
    dialog.addEventListener('cancel', (e) => e.preventDefault());
    document.body.append(dialog);
    dialog.showModal();
  });
}

export function headerBar(title, active, client, extra) {
  const links = [['Voice Lab', '../lab/'], ['Control Panel', '../panel/']];
  return h('header', { class: 'bar' },
    h('h1', {}, title),
    h('nav', {}, links.map(([name, href]) => h('a', { href, ...(name === active ? { 'aria-current': 'page' } : {}) }, name))),
    h('span', { class: 'grow' }),
    extra,
    h('span', { class: 'small muted' }, client.url.replace(/^https?:\/\//, '')),
    h('button', { onclick: () => client.signOut() }, 'Sign out'));
}

export const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDate = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Fetches audio with the sign-in and returns a playable object URL.
export async function audioUrl(client, path) {
  return URL.createObjectURL(await client.get(path, { blob: true }));
}
