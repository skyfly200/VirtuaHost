// A script as lines, each with a speaker from the cast and its text. Two views edit the same lines: "Lines" (a row per line,
// with reordering) and "Text" (the "Name: line" format, one line per row). Switching converts between them. With one voice
// (or no cast) the lines carry no names: the script is plain text spoken by that one voice.
import { h } from './kit.js';

const grow = (ta) => { ta.style.height = 'auto'; if (ta.scrollHeight) ta.style.height = `${ta.scrollHeight}px`; };

export function lineEditor({ cast = [], text = '', onchange = () => {}, maxLines = 40 } = {}) {
  let view = 'lines';
  let castAll = []; // every cast entry's name, including blanks (a blank one is a problem once there are lines)
  let names = [];   // the non-blank names
  let multi = false;
  let lines = [];   // { speaker, text }
  let raw = '';     // the Text view's content while it is open

  const el = h('div', { class: 'script-editor' });
  const body = h('div', { class: 'line-body' });
  const problemNote = h('div', { class: 'small bad', hidden: true });
  const seg = {
    lines: h('button', { type: 'button', class: 'seg', 'aria-pressed': 'true', onclick: () => show('lines') }, 'Lines'),
    text: h('button', { type: 'button', class: 'seg', 'aria-pressed': 'false', onclick: () => show('text') }, 'Text'),
  };
  el.append(h('div', { class: 'seg-row' }, seg.lines, seg.text), body, problemNote);

  function setCast(c = []) {
    castAll = (c || []).map((m) => (typeof m === 'string' ? m : m?.name ?? '').trim());
    names = castAll.filter(Boolean);
    multi = castAll.length >= 2;
  }

  // The Text view's rule is the one parseDialogue (shared/speaker.js) uses; it is copied here so this module needs only kit.js.
  // Differences: a line whose name has no text is dropped rather than appended to the line before, a name is matched to the
  // cast ignoring case, and a leading line with no name is kept (without a speaker) so the problems list can show it.
  function parse(t) {
    const out = [];
    for (const src of String(t || '').split('\n')) {
      if (!src.trim()) continue;
      if (!multi) { out.push({ speaker: '', text: src.trim() }); continue; }
      const m = /^\s*([^:(\n[\]]{1,30}?)\s*(?:\([^)]*\))?\s*:\s*(.*)$/.exec(src);
      if (m) {
        const speaker = names.find((n) => n.toLowerCase() === m[1].trim().toLowerCase()) || m[1].trim();
        if (m[2].trim()) out.push({ speaker, text: m[2].trim() });
      } else if (out.length) out[out.length - 1].text += ` ${src.trim()}`;
      else out.push({ speaker: '', text: src.trim() });
    }
    return out;
  }

  // Lines with no text are not spoken, so they are left out of the text.
  const serialize = () => lines.filter((l) => l.text.trim())
    .map((l) => (multi && l.speaker ? `${l.speaker}: ${l.text}` : l.text)).join('\n');

  const nextSpeaker = () => {
    if (!multi || !names.length) return '';
    const k = names.indexOf(lines.length ? lines[lines.length - 1].speaker : null);
    return names[(k + 1) % names.length];
  };

  function speakerOptions(speaker) {
    const opts = names.map((n) => h('option', { value: n }, n));
    if (!names.includes(speaker)) opts.push(h('option', { value: speaker, class: 'bad' }, `${speaker || '(no speaker)'} (not in the cast)`));
    return opts;
  }

  function fillSpeaker(sel, speaker) { sel.replaceChildren(...speakerOptions(speaker)); sel.value = speaker; }

  function lineRow(line, i) {
    const n = i + 1;
    const count = h('div', { class: 'small muted' }, `${line.text.length} characters`);
    const ta = h('textarea', {
      rows: 2, 'aria-label': `Line ${n} text`, value: line.text,
      oninput: (e) => {
        // A pasted line break would split the line on the next read, so it becomes a space.
        const v = e.target.value.replace(/\s*\n+\s*/g, ' ');
        if (v !== e.target.value) e.target.value = v;
        line.text = v; count.textContent = `${v.length} characters`; grow(ta); emit();
      },
      onfocus: () => grow(ta),
    });
    const sel = multi ? h('select', { 'aria-label': `Line ${n} speaker`, onchange: (e) => { line.speaker = e.target.value; fillSpeaker(sel, line.speaker); emit(); } }) : null;
    if (sel) fillSpeaker(sel, line.speaker);
    const act = (label, extra) => h('button', { type: 'button', class: 'secondary', 'aria-label': label, 'data-act': extra.act, disabled: extra.disabled, onclick: extra.onclick }, extra.text);
    const up = act(`Move line ${n} up`, { act: 'up', text: '↑', disabled: i === 0, onclick: () => move(i, -1) });
    const down = act(`Move line ${n} down`, { act: 'down', text: '↓', disabled: i === lines.length - 1, onclick: () => move(i, 1) });
    const del = act(`Delete line ${n}`, { act: 'delete', text: 'Delete', onclick: () => { lines.splice(i, 1); draw(); emit(); } });
    return h('div', { class: 'line-row', 'data-line': i },
      h('div', { class: 'line-top' }, sel, h('div', { class: 'line-actions' }, up, down, del)),
      ta, count);
  }

  function move(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= lines.length) return;
    [lines[i], lines[j]] = [lines[j], lines[i]];
    draw(`[data-line="${j}"] [data-act="${dir < 0 ? 'up' : 'down'}"]`);
    emit();
  }

  function addLine() {
    if (lines.length >= maxLines) return;
    lines.push({ speaker: nextSpeaker(), text: '' });
    draw(`[data-line="${lines.length - 1}"] textarea`);
    emit();
  }

  function linesView() {
    const full = lines.length >= maxLines;
    return h('div', { class: 'line-list' },
      lines.map(lineRow),
      h('div', { class: 'line-add' },
        h('button', { type: 'button', disabled: full, onclick: addLine }, 'Add a line'),
        full ? h('span', { class: 'small muted' }, `At most ${maxLines} lines`) : null));
  }

  // Text edits update the lines at once (so getText and problems stay current); the textarea itself is only rebuilt on a view change.
  const textView = () => h('textarea', {
    rows: 10, 'aria-label': 'Script text', value: raw,
    oninput: (e) => { raw = e.target.value; lines = parse(raw); emit(); },
  });

  function paintProblems() {
    const msgs = problems();
    problemNote.replaceChildren(...msgs.map((m) => h('div', {}, m)));
    problemNote.hidden = !msgs.length;
  }

  function draw(focus) {
    for (const [k, b] of Object.entries(seg)) { b.className = view === k ? 'seg on' : 'seg'; b.setAttribute('aria-pressed', String(view === k)); }
    body.replaceChildren(view === 'lines' ? linesView() : textView());
    if (view === 'lines') requestAnimationFrame(() => body.querySelectorAll('textarea').forEach(grow));
    if (focus) body.querySelector(focus)?.focus();
    paintProblems();
  }

  function emit() { paintProblems(); onchange(serialize()); }

  function show(v) {
    if (v === view) return;
    view = v;
    if (v === 'text') raw = serialize();
    draw();
  }

  // Programmatic changes do not call onchange (the caller already holds the value it set).
  function setText(t) {
    lines = parse(t);
    raw = String(t || '');
    draw();
  }

  function problems() {
    const out = [];
    if (multi && castAll.some((n) => !n) && lines.some((l) => l.text.trim())) out.push('A cast member has no name.');
    if (multi) {
      lines.forEach((l, i) => {
        if (!l.text.trim() || (l.speaker && names.includes(l.speaker))) return;
        out.push(l.speaker ? `Line ${i + 1}: "${l.speaker}" is not in the cast.` : `Line ${i + 1} has no speaker.`);
      });
    }
    if (lines.length > maxLines) out.push(`${lines.length} lines; at most ${maxLines} are allowed.`);
    return out;
  }

  // The cast is set before the text is parsed, because the speakers are matched against it.
  function setCastAndRedraw(c) {
    setCast(c);
    if (view === 'text') raw = serialize();
    draw();
  }

  setCast(cast);
  lines = parse(text);
  raw = serialize();
  draw();

  return { el, getText: serialize, setText, setCast: setCastAndRedraw, problems };
}
