// Shared by every part of the UI: an element helper, a small API client, toasts and formatting.
// No build step and no dependencies: plain ES modules served as they are.

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
  const t = h('div', { class: `toast ${type}`, title: 'Click to dismiss', onclick: () => t.remove() }, message);
  box.append(t);
  setTimeout(() => t.remove(), type === 'error' ? 10000 : 3500);
}

export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

// A client for one API base, for example the site's /api, /api/hub or /api/voice. `session` = { url, headers }.
export function createClient(session, { onUnauthorized } = {}) {
  async function request(method, path, { body, raw, query, blob, contentType, signal, headers: extra } = {}) {
    const url = new URL(path.replace(/^\//, ''), session.url.endsWith('/') ? session.url : `${session.url}/`);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    const headers = { ...session.headers, ...(extra || {}) };
    let payload;
    if (raw) { payload = raw; headers['content-type'] = contentType || raw.type || 'application/octet-stream'; } else if (body !== undefined) { payload = JSON.stringify(body); headers['content-type'] = 'application/json'; }
    let res;
    try { res = await fetch(url, { method, headers, body: payload, signal }); } catch (err) {
      throw new ApiError(`Cannot reach the site (${err.message}). Check your connection and try again.`, 0);
    }
    if (res.status === 401 && onUnauthorized) onUnauthorized();
    if (!res.ok) {
      let message = `${res.status} ${res.statusText}`;
      try { const j = await res.json(); if (j && j.error) message = j.error; } catch { /* keep status text */ }
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

export const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export const fmtDate = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// Fetches audio with the sign-in and returns a playable object URL.
export async function audioUrl(client, path) {
  return URL.createObjectURL(await client.get(path, { blob: true }));
}
