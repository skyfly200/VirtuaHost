// How a model is shown in a picker: its name plus what matters before choosing it, the price tier (only when it is not the middle one)
// and whether it filters strong language ("filtered" / "light filter" / "unfiltered"; models nobody has checked show nothing).
// options.models.info comes from GET /api/options.
const FILTER = { filtered: 'filtered', light: 'light filter', open: 'unfiltered' };

export const infoOf = (options, id) => ((options.models && options.models.info) || {})[id];
export const filterLevel = (options, id) => { const i = infoOf(options, id); return i && i.content ? i.content.level : 'unknown'; };

// A model that failed (lib/model-health.ts): "retired" ones are never offered; "failing" ones (empty or no replies lately) stay but are flagged.
export const flagOf = (options, id) => { const i = infoOf(options, id); return i && i.flag ? i.flag : null; };
export const isOffered = (options, id) => { const f = flagOf(options, id); return !f || f.status !== 'retired'; };

export function modelLabel(options, id) {
  const i = infoOf(options, id);
  if (!i) return id;
  const flag = flagOf(options, id);
  const tags = [flag ? (flag.status === 'retired' ? 'retired' : 'failing lately') : '', i.tier && i.tier !== 'standard' ? i.tier : '', FILTER[filterLevel(options, id)] || ''].filter(Boolean);
  return tags.length ? `${id}  [${tags.join(', ')}]` : id;
}

// For "strong language" mode: models that filter are left out of the list.
export const allowsStrongLanguage = (options, id) => filterLevel(options, id) !== 'filtered';
