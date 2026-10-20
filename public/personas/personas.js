// Personas tab: who the host is. Draft one with the AI from a short description, edit it, save it, and hear a line in its voice.
// Saved personas appear in the Generate tab's Persona picker.
import { h, clear, toast } from '../shared/kit.js';

const LINES = (value) => value.split('\n').map((l) => l.trim()).filter(Boolean);

export async function mountPersonas(root, api) {
  clear(root, h('p', { class: 'muted' }, 'Loading...'));
  let personas = [];
  let options = null;
  try {
    [{ personas }, options] = await Promise.all([api.get('/personas'), api.get('/options')]);
  } catch (err) {
    clear(root, h('p', { class: 'bad' }, `Could not load personas: ${err.message}`));
    return;
  }

  const listBox = h('div', { class: 'stack' });
  const editorBox = h('div');
  let current = null; // the persona being edited: { id?, name, ... , builtin? }

  const blank = () => ({ name: '', description: '', instructions: '', tone: '', voice: '', speechModel: '', templates: [], stationIds: [] });

  function paintList() {
    clear(listBox, personas.map((p) => h('div', { class: 'clip' },
      h('div', { class: 'row small muted' }, p.builtin ? h('span', { class: 'chip' }, 'built in') : null, p.tone ? h('span', {}, p.tone) : null),
      h('strong', {}, p.name),
      h('p', { class: 'clip-script' }, p.description || p.instructions.slice(0, 140)),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => edit(p) }, p.builtin ? 'View' : 'Edit'),
        h('button', { type: 'button', onclick: () => edit({ ...p, id: undefined, builtin: false, name: `${p.name} (copy)` }) }, 'Duplicate')))));
  }

  function edit(persona) {
    current = { ...blank(), ...persona };
    paintEditor();
    editorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function paintEditor() {
    if (!current) { clear(editorBox); return; }
    const locked = Boolean(current.builtin);
    const field = (label, key, { rows, placeholder, list } = {}) => {
      const value = list ? current[key].join('\n') : current[key] || '';
      const input = rows ? h('textarea', { rows, placeholder, disabled: locked }) : h('input', { placeholder, disabled: locked });
      input.value = value;
      input.oninput = () => { current[key] = list ? LINES(input.value) : input.value; };
      return h('label', { class: 'field' }, label, input);
    };
    const speechIds = options.models && options.models.choosable ? options.models.speech.map((m) => m.id) : [];
    const speechSelect = h('select', { disabled: locked || !speechIds.length, onchange: (e) => { current.speechModel = e.target.value; } },
      h('option', { value: '' }, 'Use the default'), speechIds.map((id) => h('option', { value: id, selected: id === current.speechModel }, id)));

    const describe = h('input', { placeholder: 'e.g. a sleepy night-owl who loves jazz and calls everyone "friend"', 'aria-label': 'Describe the host' });
    const draftStatus = h('span', { class: 'small muted', role: 'status' });
    const draftButton = h('button', { type: 'button', onclick: async () => {
      if (!describe.value.trim()) { draftStatus.textContent = 'Describe the host first.'; return; }
      draftButton.disabled = true; draftStatus.classList.remove('bad'); draftStatus.textContent = 'Writing a persona...';
      try {
        const { persona } = await api.post('/personas/generate', { description: describe.value.trim() });
        current = { ...blank(), ...persona, id: current.id };
        paintEditor();
        toast('Drafted. Edit anything, then save.', 'info');
      } catch (err) { draftStatus.textContent = err.message; draftStatus.classList.add('bad'); draftButton.disabled = false; }
    } }, 'Draft with AI');

    const heard = h('div');
    const hear = h('button', { type: 'button', onclick: async (e) => {
      const line = (current.stationIds[0] || current.templates[0] || '').replace(/\{artist\}/g, 'Ada Lovelace and the Engines').replace(/\{title\}/g, 'Analytical Love');
      if (!line) { toast('Add a station ID or a template line to hear.', 'error'); return; }
      const button = e.currentTarget; button.disabled = true;
      try {
        const body = { mode: 'say', text: line, preview: true, ...(current.tone ? { tone: current.tone } : {}), ...(current.voice ? { voice: current.voice } : {}), ...(current.speechModel ? { speechModel: current.speechModel } : {}) };
        const data = await api.post('/generate', body);
        const bytes = Uint8Array.from(atob(data.audio), (c) => c.charCodeAt(0));
        const player = h('audio', { controls: true, src: URL.createObjectURL(new Blob([bytes], { type: data.mimeType })) });
        clear(heard, player); player.play().catch(() => {});
      } catch (err) { toast(err.message, 'error'); } finally { button.disabled = false; }
    } }, 'Hear a line');

    const saveButton = h('button', { class: 'primary', type: 'button', disabled: locked, onclick: async () => {
      saveButton.disabled = true;
      try {
        const body = { ...current };
        const { persona } = current.id ? await api.put(`/personas/${encodeURIComponent(current.id)}`, body) : await api.post('/personas', body);
        personas = (await api.get('/personas')).personas;
        current = { ...blank(), ...persona };
        paintList(); paintEditor();
        toast('Persona saved.', 'info');
      } catch (err) { toast(err.message, 'error'); saveButton.disabled = false; }
    } }, current.id ? 'Save changes' : 'Save persona');
    const deleteButton = current.id && !locked ? h('button', { type: 'button', onclick: async () => {
      if (!confirm(`Delete "${current.name}"?`)) return;
      try { await api.del(`/personas/${encodeURIComponent(current.id)}`); personas = (await api.get('/personas')).personas; current = null; paintList(); paintEditor(); toast('Deleted.', 'info'); } catch (err) { toast(err.message, 'error'); }
    } }, 'Delete') : null;

    clear(editorBox, h('section', { class: 'card' },
      h('h2', {}, locked ? `${current.name} (built in, read only)` : current.id ? `Edit ${current.name}` : 'New persona'),
      locked ? h('p', { class: 'muted small' }, 'Use Duplicate on the list to make a copy you can change.') : h('div', { class: 'grid' },
        h('label', { class: 'field' }, 'Let the AI draft it from a description', describe), h('div', { class: 'row' }, draftButton, draftStatus)),
      h('div', { class: 'grid' },
        field('Name', 'name'),
        field('One-line description', 'description'),
        field('Character brief (who they are, how they talk; the AI writer reads this)', 'instructions', { rows: 5 }),
        field('Tone', 'tone', { placeholder: 'e.g. weathered, dry, slow' }),
        h('div', { class: 'grid cols' }, field('Voice (optional)', 'voice', { placeholder: 'model default' }), h('label', { class: 'field' }, 'Speech model (optional)', speechSelect)),
        field('Example link lines, one per line ({artist} and {title} are filled in)', 'templates', { rows: 4, list: true }),
        field('Station IDs, one per line', 'stationIds', { rows: 3, list: true })),
      h('div', { class: 'row' }, saveButton, hear, deleteButton, h('button', { type: 'button', onclick: () => { current = null; paintEditor(); } }, 'Close')),
      heard));
  }

  clear(root, h('div', { class: 'stack' },
    h('section', { class: 'card' },
      h('h2', {}, 'Personas'),
      h('p', { class: 'muted small' }, 'A persona is the host: their character, tone and voice. Pick one in the Generate tab and the AI writes in character.'),
      h('div', { class: 'row' }, h('button', { class: 'primary', type: 'button', onclick: () => edit(blank()) }, 'New persona')),
      listBox),
    editorBox));
  paintList();
}
