// Some writing models (DeepSeek in particular) copy the example lines in a persona's brief almost word for word. The prompt already says not to
// (lib/formats.ts); this checks the result, so a copied line can be retried or reported instead of airing again and again.

const words = (s: string): string[] => s.toLowerCase().replace(/\{\{[^}]*\}\}|\{[a-z]+\}/g, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

/** Example lines inside a persona brief: anything in quotes, plus the persona's own template lines. */
export function exampleLines(instructions: string | undefined, templates: string[] = []): string[] {
  const out: string[] = [...templates];
  for (const m of (instructions ?? "").matchAll(/["“]([^"”]{12,300})["”]/g)) out.push(m[1]);
  return out.filter((l) => words(l).length >= 4);
}

/** Share of the example's 3-word runs that also appear in the text (0..1). */
export function overlap(text: string, example: string): number {
  const a = words(text); const b = words(example);
  if (b.length < 3 || a.length < 3) return 0;
  const grams = new Set<string>();
  for (let i = 0; i + 3 <= a.length; i += 1) grams.add(a.slice(i, i + 3).join(" "));
  let hit = 0; let total = 0;
  for (let i = 0; i + 3 <= b.length; i += 1) { total += 1; if (grams.has(b.slice(i, i + 3).join(" "))) hit += 1; }
  return total ? hit / total : 0;
}

/** The example line the text copies (60% or more of its word runs), if any. */
export function copiedExample(text: string, examples: string[]): string | undefined {
  return examples.find((e) => overlap(text, e) >= 0.6);
}
