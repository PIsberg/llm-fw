/**
 * Meaning-preserving perturbations of an attack, for the mutation-resilience
 * gate (#541, scripts/fuzz-rules.ts). A rule fitted to one wording often
 * fails on the same request reworded; these are the cheap rewordings an
 * attacker tries first. Each is deterministic for a given seed, so a gate
 * built on them measures the same variants on every run.
 */

/** mulberry32: a small seeded PRNG, enough for reproducible choices. */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const HOMOGLYPHS: Record<string, string> = { a: 'а', e: 'е', o: 'о', c: 'с', p: 'р', x: 'х', i: 'і', y: 'у' }
const LEET: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' }
// Swaps that keep an instruction an instruction, in the words rules key on.
const SYNONYMS: Record<string, string> = {
  ignore: 'disregard', previous: 'prior', instructions: 'directions', forget: 'drop',
  reveal: 'show', rules: 'guidelines', pretend: 'act', tell: 'give', above: 'earlier',
  bypass: 'get around', restrictions: 'limits', print: 'output', secret: 'hidden',
}

function eachChar(text: string, map: Record<string, string>, rate: number, next: () => number): string {
  return [...text].map(ch => {
    const sub = map[ch.toLowerCase()]
    return sub !== undefined && next() < rate ? sub : ch
  }).join('')
}

export type Mutation = (text: string, next: () => number) => string

export const MUTATIONS: Record<string, Mutation> = {
  // Cyrillic look-alikes for Latin letters (the normalizer folds these).
  homoglyph: (t, next) => eachChar(t, HOMOGLYPHS, 0.3, next),
  leetspeak: (t, next) => eachChar(t, LEET, 0.4, next),
  'zero-width': (t, next) => [...t].map(ch => (/\p{L}/u.test(ch) && next() < 0.2 ? `${ch}​` : ch)).join(''),
  casing: (t, next) => [...t].map(ch => (next() < 0.5 ? ch.toUpperCase() : ch.toLowerCase())).join(''),
  'markdown-fence': t => `\`\`\`\n${t}\n\`\`\``,
  blockquote: t => t.split('\n').map(l => `> ${l}`).join('\n'),
  'polite-prefix': t => `Hi there, hope your day is going well! ${t}`,
  synonyms: t => t.replace(/[A-Za-z]+/g, w => {
    const sub = SYNONYMS[w.toLowerCase()]
    if (sub === undefined) return w
    return w[0] === w[0]!.toUpperCase() ? sub[0]!.toUpperCase() + sub.slice(1) : sub
  }),
  'no-punctuation': t => t.replace(/[.,!?;:]/g, ''),
}

/**
 * Mutations that rewrite characters. An encoded attack (base64, hex, ascii85)
 * is its payload: changing a character of it destroys the instruction, so the
 * variant is no longer an attack and its passing says nothing.
 */
export const CHARACTER_LEVEL: ReadonlySet<string> = new Set(['homoglyph', 'leetspeak', 'zero-width', 'casing', 'no-punctuation'])

/**
 * Every mutation of `text` that keeps it an attack, each from its own seeded
 * stream. `encoded` skips the character-level ones.
 */
export function mutate(text: string, seed: number, encoded = false): Array<{ mutation: string; text: string }> {
  return Object.entries(MUTATIONS)
    .map(([mutation, fn], k) => ({ mutation, text: fn(text, rng(seed * 31 + k)) }))
    .filter(v => !encoded || !CHARACTER_LEVEL.has(v.mutation))
}

export interface ResilienceCount { kept: number; total: number }

/**
 * Per mutation, the fewest variants of blocked attacks that must still block.
 * Measured with the cheap pipeline on the 77 attacks of
 * test/detection/fixtures/corpus.json (the blocked ones are the seeds), minus a
 * margin of 1. Raise a floor when resilience improves; a rule change that
 * drops one is a rule fitted to a wording.
 *
 * Measured on ruleset 2026.10.101, 76 seeds (68 without the encoded ones):
 * homoglyph 67 (68 after #557), leetspeak 67, zero-width 68, casing 68, markdown-fence 76,
 * blockquote 76, polite-prefix 72, synonyms 71, no-punctuation 64. What
 * passes is real: a Cyrillic-lettered coercion threat, a polite opener before
 * "New system message:", "drop everything I have told you" (#541).
 */
export const RESILIENCE_FLOORS: Record<string, ResilienceCount> = {
  homoglyph: { kept: 67, total: 68 },
  leetspeak: { kept: 66, total: 68 },
  'zero-width': { kept: 67, total: 68 },
  casing: { kept: 67, total: 68 },
  'markdown-fence': { kept: 75, total: 76 },
  blockquote: { kept: 75, total: 76 },
  'polite-prefix': { kept: 71, total: 76 },
  synonyms: { kept: 70, total: 76 },
  'no-punctuation': { kept: 63, total: 68 },
}

export function evaluateResilience(counts: Record<string, ResilienceCount>, floors: Record<string, ResilienceCount>): { passed: boolean; failures: string[] } {
  const failures: string[] = []
  for (const [name, floor] of Object.entries(floors)) {
    const c = counts[name]
    if (!c) { failures.push(`${name}: did not run`); continue }
    if (c.total !== floor.total) { failures.push(`${name}: ${c.total} seeds, the floor was measured on ${floor.total}`); continue }
    if (c.kept < floor.kept) failures.push(`${name}: ${c.kept} of ${c.total} variants still blocked, floor ${floor.kept}`)
  }
  return { passed: failures.length === 0, failures }
}
