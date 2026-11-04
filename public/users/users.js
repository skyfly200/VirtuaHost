// Users tab (admins): add people, set their role, disable or remove them, reset passwords, and set their limits.
// Also exports mountAccount for everyone: your role, how much of your limits you have used, and a change-password form.
import { h, clear, toast } from '../shared/kit.js';
import { keyBox } from '../shared/keybox.js';

const patch = (api, path, body) => api.request('PATCH', path, { body });
const LIMITS = [
  ['dailyAi', 'AI requests / day'],
  ['monthlyAi', 'AI requests / month'],
  ['maxClips', 'Saved clips'],
  ['maxSchedules', 'Schedules'],
];

export async function mountUsers(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let users = []; let defaults = {};
  const load = async () => { ({ users, defaults } = await api.get('/users')); };
  try { await load(); } catch (err) { clear(root, h('p', { class: 'bad' }, `Could not load users: ${err.message}`)); return; }

  const listBox = h('div', { class: 'stack' });
  const reload = async () => { await load(); paintList(); };
  const limitText = (q) => LIMITS.map(([k, label]) => `${label}: ${q[k] ?? (defaults[k] !== undefined ? `${defaults[k]} (default)` : 'no limit')}`).join(' · ');

  function paintList() {
    clear(listBox, users.map((u) => {
      const env = u.source === 'env';
      const act = (fn) => async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(); await reload(); } catch (err) { toast(err.message, 'error'); b.disabled = false; } };
      return h('div', { class: 'clip' },
        h('div', { class: 'row small muted' }, h('span', { class: 'chip' }, u.role), u.disabled ? h('span', { class: 'chip' }, 'disabled') : null, env ? h('span', { class: 'chip', title: 'Set in LOGIN_USERS; change it in the site settings' }, 'from LOGIN_USERS') : null),
        h('strong', {}, u.username),
        h('p', { class: 'small muted' }, u.lastLoginAt ? `Last signed in ${new Date(u.lastLoginAt).toLocaleString()}` : 'Never signed in'),
        env ? null : h('p', { class: 'small muted' }, u.role === 'admin' ? 'Admins have no limits.' : limitText(u.quota || {})),
        env ? null : h('div', { class: 'row' },
          h('button', { type: 'button', onclick: act(() => patch(api, `/users/${u.username}`, { role: u.role === 'admin' ? 'user' : 'admin' })) }, u.role === 'admin' ? 'Make regular user' : 'Make admin'),
          h('button', { type: 'button', onclick: act(() => patch(api, `/users/${u.username}`, { disabled: !u.disabled })) }, u.disabled ? 'Enable' : 'Disable'),
          u.role === 'admin' ? null : h('button', { type: 'button', onclick: () => editLimits(u) }, 'Limits'),
          h('button', { type: 'button', onclick: async (e) => {
            const pw = prompt(`New password for ${u.username} (10 or more characters):`);
            if (!pw) return;
            const b = e.currentTarget; b.disabled = true;
            try { await patch(api, `/users/${u.username}`, { password: pw }); toast('Password changed', 'info'); } catch (err) { toast(err.message, 'error'); }
            b.disabled = false;
          } }, 'Reset password'),
          h('button', { type: 'button', class: 'link danger', onclick: async () => { if (!confirm(`Delete ${u.username}? Their clips, personas and schedules stay, but only admins can manage them.`)) return; try { await api.del(`/users/${u.username}`); await reload(); } catch (err) { toast(err.message, 'error'); } } }, 'Delete')));
    }));
  }

  function editLimits(u) {
    const inputs = LIMITS.map(([k, label]) => [k, h('input', { type: 'number', min: 0, step: 1, placeholder: defaults[k] !== undefined ? `default ${defaults[k]}` : 'no limit', value: (u.quota || {})[k] ?? '' }), label]);
    const dialog = h('section', { class: 'card' },
      h('h3', {}, `Limits for ${u.username}`),
      h('p', { class: 'small muted' }, 'Leave a box empty to use the site default. 0 blocks it completely. Days and months are UTC.'),
      h('div', { class: 'grid cols' }, inputs.map(([, input, label]) => h('label', { class: 'field' }, label, input))),
      h('div', { class: 'row' },
        h('button', { class: 'primary', type: 'button', onclick: async () => {
          const quota = Object.fromEntries(inputs.map(([k, input]) => [k, input.value === '' ? null : Number(input.value)]));
          try { await patch(api, `/users/${u.username}`, { quota }); dialog.remove(); await reload(); } catch (err) { toast(err.message, 'error'); }
        } }, 'Save limits'),
        h('button', { type: 'button', onclick: () => dialog.remove() }, 'Cancel')));
    listBox.before(dialog);
    dialog.scrollIntoView({ block: 'center' });
  }

  // ---------- add a person ----------
  const name = h('input', { autocomplete: 'off', 'aria-label': 'Username', required: true, maxlength: 40, placeholder: 'letters, numbers . _ @ -' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password', required: true, minlength: 10, placeholder: 'at least 10 characters' });
  const problem = h('p', { class: 'bad small', role: 'alert' });
  const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'user' }, 'Regular user'), h('option', { value: 'admin' }, 'Admin'));
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    problem.textContent = '';
    try {
      await api.post('/users', { username: name.value, password: pass.value, role: role.value });
      name.value = ''; pass.value = '';
      toast('User added', 'info');
      await reload();
    } catch (err) { problem.textContent = err.message; toast(err.message, 'error'); }
  } },
  h('h2', {}, 'Add a person'),
  h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Username', name), h('label', { class: 'field' }, 'Password (10+ characters)', pass), h('label', { class: 'field' }, 'Role', role)),
  problem,
  h('button', { class: 'primary', type: 'submit' }, 'Add'));

  clear(root,
    h('section', { class: 'card' },
      h('h2', {}, 'Users'),
      h('p', { class: 'small muted' }, 'Admins manage everything, including users, stations and the Control tab. Regular users see the station\'s shared content plus their own clips, personas and schedules, within their limits.'),
      listBox),
    form);
  paintList();
}

// ---------- account settings: one card for each concern, so changing one never touches another ----------
const PROVIDER_NAMES = { google: 'Google', github: 'GitHub' };
const real = (me) => !(me.username === 'api-key' || me.username === 'local');

function usageCard(me) {
  const usage = me.usage || { daily: 0, monthly: 0 };
  const q = me.quota || {};
  const lines = me.role === 'admin' ? ['No limits.'] : [
    q.dailyAi !== undefined ? `AI requests today: ${usage.daily} of ${q.dailyAi}` : null,
    q.monthlyAi !== undefined ? `AI requests this month: ${usage.monthly} of ${q.monthlyAi}` : null,
    q.maxClips !== undefined ? `Up to ${q.maxClips} saved clips` : null,
    q.maxSchedules !== undefined ? `Up to ${q.maxSchedules} schedules` : null,
  ].filter(Boolean);
  return h('section', { class: 'card' }, h('h3', {}, `${me.username} (${me.role})`), h('p', { class: 'small muted' }, lines.length ? lines.join(' · ') : 'No limits set for you.'));
}

function emailCard(api, me, refresh) {
  const email = h('input', { type: 'email', autocomplete: 'email', 'aria-label': 'Email', value: me.email || '', placeholder: 'you@example.com' });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  return h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await patch(api, '/users/me', { email: email.value, currentPassword: pw.value }); pw.value = ''; toast('Email saved', 'info'); await refresh(); } catch (err) { toast(err.message, 'error'); }
  } },
  h('h3', {}, 'Email'),
  h('p', { class: 'small muted' }, 'Kept on your account. Leave it empty and save to remove it. Your current password confirms the change.'),
  h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Email address', email), h('label', { class: 'field' }, 'Current password', pw), h('button', { type: 'submit' }, 'Save email')));
}

function signInCard(api, me, refresh) {
  const available = me.providers || [];
  const rows = Object.keys(PROVIDER_NAMES).map((p) => {
    const linked = (me.identities || {})[p];
    return h('div', { class: 'row' },
      h('span', {}, linked ? `${PROVIDER_NAMES[p]}: ${linked.label}` : `${PROVIDER_NAMES[p]}: not linked`),
      linked
        ? h('button', { type: 'button', class: 'link danger', onclick: async () => { if (!confirm(`Unlink ${PROVIDER_NAMES[p]}? You can still sign in with your password.`)) return; try { await api.del(`/oauth/${p}`); await refresh(); } catch (err) { toast(err.message, 'error'); } } }, 'Unlink')
        : h('button', { type: 'button', disabled: !available.includes(p), title: available.includes(p) ? '' : `${PROVIDER_NAMES[p]} sign-in is not set up on this site`, onclick: async () => {
          try { const { url } = await api.post(`/oauth/${p}/start`, {}); location.href = url; } catch (err) { toast(err.message, 'error'); }
        } }, `Link ${PROVIDER_NAMES[p]}`));
  });
  return h('section', { class: 'card' },
    h('h3', {}, 'Sign-in methods'),
    h('p', { class: 'small muted' }, 'Link a Google or GitHub login to this account to sign in with it. A linked login signs in this account only; one Google or GitHub account can belong to one person here.'),
    rows);
}

function passwordCard(api) {
  const current = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  return h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try { await patch(api, '/users/me', { currentPassword: current.value, newPassword: next.value }); current.value = ''; next.value = ''; toast('Password changed', 'info'); } catch (err) { toast(err.message, 'error'); }
  } },
  h('h3', {}, 'Password'),
  h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Current password', current), h('label', { class: 'field' }, 'New password (10+ characters)', next), h('button', { type: 'submit' }, 'Change password')));
}

// The account page: reached from the user menu at the top right.
export function mountAccount(root, api, me) {
  const body = h('div', { class: 'stack' });
  root.replaceChildren(h('h2', {}, 'Account settings'), body);
  const paint = (who) => {
    const keys = real(who) ? ['openrouter', 'gemini', 'elevenlabs'].map((p) => h('section', { class: 'card' }, keyBox(api, { provider: p }))) : [];
    clear(body,
      usageCard(who),
      real(who) ? emailCard(api, who, refresh) : null,
      real(who) ? signInCard(api, who, refresh) : null,
      real(who) ? passwordCard(api) : null,
      keys.length ? h('h3', {}, 'AI keys') : null,
      keys);
  };
  async function refresh() { try { me = { ...me, ...(await api.get('/users/me')) }; } catch { /* keep what we had */ } paint(me); }
  paint(me);
  refresh();
}
