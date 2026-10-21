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
  const name = h('input', { autocomplete: 'off', 'aria-label': 'Username' });
  const pass = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'Password' });
  const role = h('select', { 'aria-label': 'Role' }, h('option', { value: 'user' }, 'Regular user'), h('option', { value: 'admin' }, 'Admin'));
  const form = h('form', { class: 'card', onsubmit: async (e) => {
    e.preventDefault();
    try {
      await api.post('/users', { username: name.value, password: pass.value, role: role.value });
      name.value = ''; pass.value = '';
      toast('User added', 'info');
      await reload();
    } catch (err) { toast(err.message, 'error'); }
  } },
  h('h2', {}, 'Add a person'),
  h('div', { class: 'grid cols' }, h('label', { class: 'field' }, 'Username', name), h('label', { class: 'field' }, 'Password (10+ characters)', pass), h('label', { class: 'field' }, 'Role', role)),
  h('button', { class: 'primary', type: 'submit' }, 'Add'));

  clear(root,
    h('section', { class: 'card' },
      h('h2', {}, 'Users'),
      h('p', { class: 'small muted' }, 'Admins manage everything, including users, stations and the Control tab. Regular users see the station\'s shared content plus their own clips, personas and schedules, within their limits.'),
      listBox),
    form);
  paintList();
}

// A small "your account" card for the top of the page: role, usage against limits, and change password.
export function accountCard(api, me) {
  const usage = me.usage || { daily: 0, monthly: 0 };
  const q = me.quota || {};
  const lines = me.role === 'admin' ? ['No limits.'] : [
    q.dailyAi !== undefined ? `AI requests today: ${usage.daily} of ${q.dailyAi}` : null,
    q.monthlyAi !== undefined ? `AI requests this month: ${usage.monthly} of ${q.monthlyAi}` : null,
    q.maxClips !== undefined ? `Up to ${q.maxClips} saved clips` : null,
    q.maxSchedules !== undefined ? `Up to ${q.maxSchedules} schedules` : null,
  ].filter(Boolean);
  const current = h('input', { type: 'password', autocomplete: 'current-password', 'aria-label': 'Current password' });
  const next = h('input', { type: 'password', autocomplete: 'new-password', 'aria-label': 'New password' });
  return h('details', { class: 'card' },
    h('summary', {}, `${me.username} (${me.role})`),
    h('p', { class: 'small muted' }, lines.length ? lines.join(' · ') : 'No limits set for you.'),
    me.username === 'api-key' || me.username === 'local' ? null : keyBox(api),
    me.username === 'api-key' || me.username === 'local' ? null : h('form', { class: 'grid cols', onsubmit: async (e) => {
      e.preventDefault();
      try { await patch(api, '/users/me', { currentPassword: current.value, newPassword: next.value }); current.value = ''; next.value = ''; toast('Password changed', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, h('label', { class: 'field' }, 'Current password', current), h('label', { class: 'field' }, 'New password (10+ characters)', next), h('button', { type: 'submit' }, 'Change password')));
}
