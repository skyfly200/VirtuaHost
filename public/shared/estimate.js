// Cost estimates before anything is sent to an AI service (POST /api/estimate; nothing is spent by asking). `show` keeps a one-line
// estimate on screen as the text and models change; `confirmSpend` asks first when a step uses a premium or unpriced model, or one
// much dearer than the default. These are estimates from OpenRouter's listed prices, not a bill.
import { h, clear } from './kit.js';

export function costGuard(api) {
  const el = h('p', { class: 'small muted', 'aria-live': 'polite' });
  let timer = null;
  let seq = 0;

  const ask = async (body) => { try { return (await api.post('/estimate', body)).estimate; } catch { return null; } };

  const line = (e) => h('span', { style: e.warn ? 'color:var(--warn,#b45309)' : '' }, e.warn ? '⚠ ' : '', e.message);

  // Shows the estimate for one or more steps; a quick burst of changes only asks once.
  function show(bodies) {
    clearTimeout(timer);
    const mine = ++seq;
    timer = setTimeout(async () => {
      const all = (await Promise.all(bodies.map(ask))).filter(Boolean);
      if (mine !== seq) return;
      clear(el, all.length ? all.flatMap((e, i) => [i ? h('br') : null, line(e)]) : null);
    }, 400);
  }

  // Resolves true when the step may go ahead: nothing to warn about, or the person agreed.
  async function confirmSpend(bodies, what) {
    const all = (await Promise.all(bodies.map(ask))).filter(Boolean);
    clear(el, all.flatMap((e, i) => [i ? h('br') : null, line(e)]));
    const warned = all.filter((e) => e.warn);
    if (!warned.length) return true;
    return window.confirm(`${what}\n\n${warned.map((e) => e.message).join('\n\n')}\n\nContinue?`);
  }

  return { el, show, confirmSpend };
}
