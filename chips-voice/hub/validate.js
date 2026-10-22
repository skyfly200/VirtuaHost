// Checks a written line BEFORE any money is spent on speaking it. Returns a list of problems; an empty list means it may be spoken.
//
// These are cheap, deterministic guards, not a proof: the "invented facts" check in particular is a heuristic (it catches quoted titles,
// "by <Name>" credits, numbers, web addresses and phone numbers that were not given in the request). A line that passes is still a line a
// language model wrote: shadow mode and the approval queue exist so a person reads it before it airs.
const DEFAULT_MAX_CHARS = 400;

// A short list of words a "clean" persona must not say. Add your own with the blocklist settings; "explicit-ok" personas skip this list only.
const PROFANITY = ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'shitty', 'bullshit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'piss', 'pissed', 'slut', 'whore', 'nigger', 'faggot', 'retard'];

const norm = (s) => String(s).toLowerCase().replace(/[’‘]/g, "'");
const wordRe = (w) => new RegExp(`(^|[^a-z0-9'])${String(w).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9'])`, 'i');
const words = (s) => String(s).split(/\s+/).filter(Boolean);

// Everything the request told the writer it may name or state.
function allowedText(ctx) {
  const parts = [];
  for (const n of ctx.names || []) { if (n && typeof n === 'object') parts.push(n.artist, n.title); else parts.push(n); }
  parts.push(...(ctx.facts || []), ...(ctx.allow || []), ctx.stationName, ctx.callsign, ctx.city, ctx.personaName, ctx.whenPhrase);
  return norm(parts.filter(Boolean).join(' | '));
}

function inventedThings(text, ctx) {
  const problems = [];
  const allowed = allowedText(ctx);
  const has = (s) => allowed.includes(norm(s).trim());
  // "Song Title" in quotes: must be one of the given names.
  for (const m of text.matchAll(/["“]([^"”]{2,80})["”]/g)) if (!has(m[1])) problems.push({ code: 'invented-title', message: `The line quotes "${m[1]}", which was not given in the request.` });
  // "by Artist Name", "from Artist Name", "called X", "titled X", "featuring X": the capitalised run after it must be a given name.
  for (const m of text.matchAll(/\b(?:by|called|titled|featuring|feat\.)\s+((?:[A-Z][\w'&.-]*)(?:\s+(?:of|the|and|&|[A-Z][\w'&.-]*)){0,5})/g)) {
    const name = m[1].replace(/\s+(of|the|and|&)$/i, '').trim();
    if (name.length > 1 && !has(name)) problems.push({ code: 'invented-name', message: `The line names "${name}", which was not given in the request.` });
  }
  if (/https?:\/\/|www\.|\b[\w-]+\.(?:com|net|org|fm|io)\b|\b[\w.+-]+@[\w-]+\.\w+/i.test(text) && !/https?:\/\/|www\.|\.(com|net|org|fm|io)\b|@/.test(allowed)) problems.push({ code: 'invented-contact', message: 'The line contains a web address or email that was not given in the request.' });
  if (/\b\d{3}[-.\s]\d{4}\b|\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/.test(text) && !/\d{3}[-.\s]\d{4}/.test(allowed)) problems.push({ code: 'invented-contact', message: 'The line contains a phone number that was not given in the request.' });
  // Numbers: for kinds whose numbers all come from facts (not placeholders like {{time}} or {{temp}}), each must appear in the given text.
  if (ctx.numbersMustBeGiven) {
    const given = new Set((allowed.match(/\d+/g) || []));
    for (const m of text.matchAll(/\d+/g)) if (!given.has(m[0])) { problems.push({ code: 'invented-number', message: `The line says "${m[0]}", which was not given in the request.` }); break; }
  }
  return problems;
}

// ctx: { humanText (skip the invented-facts checks: a person supplied the words), kind, maxChars, maxSeconds, languagePolicy: 'clean'|'explicit-ok', blocklist[], names[], facts[], allow[], stationName, callsign, city, personaName,
//        whenPhrase, numbersMustBeGiven, site: { unresolvedPlaceholders, copiedExample, templateMissing[] } }
function validateText(input, ctx = {}) {
  const text = typeof input === 'string' ? input.trim() : '';
  const problems = [];
  const add = (code, message) => problems.push({ code, message });
  if (!text) { add('empty', 'The writer returned no text.'); return { ok: false, problems }; }
  const wc = words(text).length;
  if (wc < 3) add('too-short', `The line is only ${wc} word${wc === 1 ? '' : 's'} long.`);
  const maxChars = ctx.maxChars || DEFAULT_MAX_CHARS;
  if (text.length > maxChars) add('too-long', `The line is ${text.length} characters; the limit for this slot is ${maxChars}.`);
  if (ctx.maxSeconds && wc / 2.5 > ctx.maxSeconds * 1.25) add('too-long', `The line would run about ${Math.round(wc / 2.5)} seconds; the slot allows ${ctx.maxSeconds}.`);
  if (/\{\{[^}]*\}\}|\{[a-z_]+\}/i.test(text)) add('unresolved-placeholder', 'The line still contains a {placeholder} that was not filled in.');
  if (ctx.site && ctx.site.unresolvedPlaceholders) add('unresolved-placeholder', 'The site reported unresolved placeholders.');
  if (ctx.site && ctx.site.templateMissing && ctx.site.templateMissing.length) add('missing-values', `Values were missing for: ${ctx.site.templateMissing.join(', ')} (set the station's city or variables).`);
  if (ctx.site && ctx.site.copiedExample) add('copied-example', 'The writer copied an example line from the persona instead of writing something new.');
  if (/[*_#`]{1,}\S|\[[^\]]{1,40}\]|\([^)]{0,30}(?:laughs|pauses|sighs|chuckles)[^)]*\)|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) add('not-speakable', 'The line contains markdown, a stage direction or an emoji that would be read aloud or garbled.');
  const lower = norm(text);
  const blocked = [...(ctx.blocklist || [])].filter(Boolean).filter((w) => wordRe(w).test(lower));
  if (blocked.length) add('blocklist', `The line contains blocked word${blocked.length === 1 ? '' : 's'}: ${blocked.join(', ')}.`);
  if ((ctx.languagePolicy || 'clean') === 'clean') {
    const bad = PROFANITY.filter((w) => wordRe(w).test(lower));
    if (bad.length) add('language', `The line contains language this persona's policy does not allow (${bad.length} word${bad.length === 1 ? '' : 's'}).`);
  }
  if (!ctx.humanText) problems.push(...inventedThings(text, ctx));            // a line a person typed has its facts from that person
  return { ok: problems.length === 0, problems };
}

module.exports = { validateText, PROFANITY, DEFAULT_MAX_CHARS };
