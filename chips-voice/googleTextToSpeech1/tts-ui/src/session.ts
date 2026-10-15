import Vue from 'vue';

const STORAGE_KEY = 'chipsvoice.session';

interface Stored { token: string; user: string; expires: number; }

function load(): Stored | null {
  try {
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
    return stored && stored.expires > Date.now() ? stored : null;
  } catch (e) {
    return null;
  }
}

const saved = load();

// Reactive login state shared by the whole app.
export const session = Vue.observable({
  token: saved ? saved.token : '',
  user: saved ? saved.user : '',
});

export function setSession(token: string, user: string, hours: number) {
  session.token = token;
  session.user = user;
  try {
    window.localStorage.setItem(STORAGE_KEY,
      JSON.stringify({ token, user, expires: Date.now() + hours * 3600 * 1000 }));
  } catch (e) { /* storage unavailable: the session lasts until reload */ }
}

export function clearSession() {
  session.token = '';
  session.user = '';
  try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
}
