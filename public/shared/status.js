// A status line that shows what is happening while something loads: a spinner, the current step ("Generating speech (2 of 3)"), a
// progress bar when there are steps, the seconds elapsed, and a "still working" note when it is slow. It ends in a clear result:
// a tick for success, a cross (in red) for failure. Used wherever the site waits on an AI or speech service.
import { h, clear } from './kit.js';

const SLOW_AFTER_S = 12;

export function createStatus() {
  const el = h('div', { class: 'status', role: 'status', 'aria-live': 'polite' });
  let timer = null;
  let started = 0;
  let current = { message: '', step: 0, total: 0 };

  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const elapsed = () => Math.round((Date.now() - started) / 1000);

  function paintBusy() {
    const s = elapsed();
    const bar = current.total > 1 ? h('progress', { max: current.total, value: Math.min(current.step, current.total), 'aria-label': 'Progress' }) : null;
    clear(el, h('span', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'status-text' }, current.message),
      current.total > 1 ? h('span', { class: 'small muted' }, `step ${Math.min(current.step, current.total)} of ${current.total}`) : null, bar,
      h('span', { class: 'small muted' }, s >= 1 ? `${s}s` : ''), s >= SLOW_AFTER_S ? h('span', { class: 'small muted' }, 'Still working: AI services can take a little while.') : null);
    el.className = 'status busy';
  }

  const api = {
    el,
    // Something is in progress. `progress` = { step, total } for work in several parts; call again to move it on.
    busy(message, progress = {}) {
      if (!timer) { started = Date.now(); timer = setInterval(paintBusy, 1000); }
      current = { message, step: progress.step || 0, total: progress.total || 0 };
      paintBusy();
    },
    ok(message) { stopTimer(); const took = started ? ((Date.now() - started) / 1000).toFixed(1) : ''; started = 0; clear(el, h('span', { class: 'tick', 'aria-hidden': 'true' }, '✓'), h('span', { class: 'status-text' }, message), took && Number(took) >= 1 ? h('span', { class: 'small muted' }, `${took}s`) : null); el.className = 'status ok'; },
    // `reply` (optional): what the AI sent back when it could not be used; shown in a drop-down under the message, to read and copy.
    fail(message, reply) {
      stopTimer(); started = 0;
      clear(el, h('span', { class: 'cross', 'aria-hidden': 'true' }, '✕'), h('span', { class: 'status-text' }, message),
        reply && reply.trim() ? h('details', { class: 'reply-details' }, h('summary', {}, `Show the full reply (${reply.length.toLocaleString()} characters)`), h('pre', {}, reply)) : null);
      el.className = 'status bad';
    },
    info(message) { stopTimer(); started = 0; clear(el, h('span', { class: 'status-text muted' }, message)); el.className = 'status'; },
    clear() { stopTimer(); started = 0; clear(el); el.className = 'status'; },
    get running() { return timer !== null; },
  };
  return api;
}
