/**
 * Fill in test/detection/fixtures/multilingual-playground.json.
 *
 * The fixture holds English source sentences (attacks from the Prompt Testing
 * playground, held-out attack phrasings, and benign prompts that share their
 * words) and their translation into every language the playground offers.
 * test/detection/multilingual-playground.test.ts runs all of them, so the
 * gate never calls the network; this script is the only thing that does.
 *
 * The `examples` set is not edited by hand: it mirrors the playground's own
 * translatable examples (src/dashboard/playgroundExamples.ts), so after changing
 * an example, run this and commit the fixture.
 *
 * To add a case to another set, put the English sentence under
 * `sets.<set>.source` with a new id and run this. It translates only what is missing, so existing rows stay
 * byte-identical and a re-run after an interruption resumes where it stopped.
 * `--refresh` re-translates everything (expect verdicts to move: the
 * translator's output changes over time).
 *
 * It uses the playground's own translateText(), the same unofficial Google
 * endpoint. That endpoint answers 429 after roughly 1,600 calls in a burst, so
 * requests are paced and a failure backs off for a minute and retries.
 *
 * Usage:
 *   npm run fixture:multilingual [-- --refresh]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TRANSLATE_LANGUAGES, translateText } from '../src/dashboard/translate.js'
import { translatableExamples } from '../src/dashboard/playgroundExamples.js'

interface FixtureSet {
  label: 0 | 1
  /** Source language passed to the translator; 'en' unless set. */
  sourceLanguage?: string
  source: Record<string, string>
  translations: Record<string, Record<string, string>>
}
interface Fixture { sets: Record<string, FixtureSet> }

const PATH = join(dirname(fileURLToPath(import.meta.url)), '../test/detection/fixtures/multilingual-playground.json')
const PACE_MS = 350
const BACKOFF_MS = 60_000

const fixture = JSON.parse(readFileSync(PATH, 'utf8')) as Fixture
const refresh = process.argv.includes('--refresh')
const save = (): void => writeFileSync(PATH, JSON.stringify(fixture, null, 1) + '\n')

// The `examples` set is the playground's own translatable examples, kept in
// step with src/dashboard/playgroundExamples.ts: a changed or removed example
// drops its translations, and the test fails until this script has run.
// Source 'auto', as the playground's Translate button sends it (one example is
// already Spanish).
fixture.sets.examples ??= { label: 1, sourceLanguage: 'auto', source: {}, translations: {} }
const examples = fixture.sets.examples
const current = translatableExamples()
for (const id of Object.keys(examples.source)) {
  if (examples.source[id] !== current[id]) {
    delete examples.source[id]
    delete examples.translations[id]
  }
}
for (const [id, text] of Object.entries(current)) examples.source[id] = text

const jobs: Array<{ set: FixtureSet; id: string; lang: string }> = []
for (const set of Object.values(fixture.sets)) {
  for (const id of Object.keys(set.source)) {
    set.translations[id] ??= {}
    const done = set.translations[id]
    for (const { code } of TRANSLATE_LANGUAGES) {
      if (code !== 'en' && (refresh || done[code] === undefined)) jobs.push({ set, id, lang: code })
    }
  }
}
process.stderr.write(`multilingual-fixture: ${jobs.length} translations to fetch\n`)

let fetched = 0
while (jobs.length > 0) {
  const job = jobs[0]
  if (!job) break
  try {
    const { translated } = await translateText(job.set.source[job.id] ?? '', job.lang, job.set.sourceLanguage ?? 'en')
    job.set.translations[job.id] ??= {}
    const row = job.set.translations[job.id]
    row[job.lang] = translated
    jobs.shift()
    if (++fetched % 50 === 0) {
      save()
      process.stderr.write(`  ${fetched} fetched, ${jobs.length} left\n`)
    }
    await new Promise(r => setTimeout(r, PACE_MS))
  } catch (err) {
    save()
    process.stderr.write(`  ${(err as Error).message}; backing off ${BACKOFF_MS / 1000} s\n`)
    await new Promise(r => setTimeout(r, BACKOFF_MS))
  }
}
save()
process.stderr.write(`multilingual-fixture: done, ${fetched} fetched\n`)
