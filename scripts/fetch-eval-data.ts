/**
 * Reproducible fetcher for the public benchmark datasets in test/eval/data/.
 *
 * Re-running this script regenerates every PUBLIC dataset file from its
 * upstream source, pinned to the revision recorded in the file's `_revision`
 * field (the revision is resolved at fetch time — the field is the record of
 * what was fetched, so benchmark numbers in docs/BENCHMARK.md stay auditable).
 *
 * heldout.json is self-authored and NOT touched by this script.
 *
 * Output schema per file:
 *   {
 *     _source:   string   — human-readable provenance
 *     _revision: string   — upstream git sha (HF dataset repo or GitHub repo)
 *     _fetched:  string   — ISO date of the fetch
 *     _threat:   'injection' | 'harmful-content' | 'indirect-injection'
 *     rows: [{ text, label, class?, surface?, turns? }]
 *   }
 *
 * `turns` holds a conversation's user turns in order (the multi-turn splits,
 * #540); `text` is then those turns joined by a blank line, for the tools that
 * only print or hash a row.
 *
 * label 1=attack 0=benign. `surface: 'tool_result'` makes the benchmark
 * harness deliver the text as an Anthropic tool_result block instead of a
 * user prompt (exercises the indirect-injection scan path).
 *
 * Usage:  node --import tsx/esm scripts/fetch-eval-data.ts [name ...]
 *         (no args = fetch all; names = subset, e.g. `jbb-behaviors harmbench`)
 */
import { writeFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { parquetReadObjects } from 'hyparquet'

const __dir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dir, '..', 'test', 'eval', 'data')

interface Row { text: string; label: number; class?: string; surface?: 'tool_result'; turns?: string[] }
type Threat = 'injection' | 'harmful-content' | 'indirect-injection' | 'multi-turn'

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { 'user-agent': 'llm-fw-benchmark-fetch' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res.json()
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'llm-fw-benchmark-fetch' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return res.text()
}

async function getBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { headers: { 'user-agent': 'llm-fw-benchmark-fetch' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} — ${url}`)
  return Buffer.from(await res.arrayBuffer())
}

/** Current sha of a HuggingFace dataset repo. */
async function hfRevision(dataset: string): Promise<string> {
  const j = await getJson(`https://huggingface.co/api/datasets/${dataset}`) as { sha: string }
  return j.sha
}

/** All rows of a HF dataset split via the datasets-server rows API (paginated). */
async function hfRows(dataset: string, config: string, split: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  for (let offset = 0; ; offset += 100) {
    const u = `https://datasets-server.huggingface.co/rows?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=100`
    const j = await getJson(u) as { rows: { row: Record<string, unknown> }[]; num_rows_total: number }
    out.push(...j.rows.map(r => r.row))
    if (out.length >= j.num_rows_total || j.rows.length === 0) break
  }
  return out
}

/** HEAD sha of a GitHub repo's default branch. */
async function ghRevision(repo: string, branch = 'main'): Promise<string> {
  const j = await getJson(`https://api.github.com/repos/${repo}/branches/${branch}`) as { commit: { sha: string } }
  return j.commit.sha
}

const ghRaw = (repo: string, sha: string, path: string) => getText(`https://raw.githubusercontent.com/${repo}/${sha}/${path}`)

/** Minimal RFC-4180 CSV parser (quoted fields, embedded commas/newlines). */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { row.push(field); field = '' }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

function csvObjects(text: string): Record<string, string>[] {
  const [header, ...rows] = parseCsv(text)
  return rows.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])))
}

function write(file: string, source: string, revision: string, threat: Threat, rows: Row[], extra: Record<string, string> = {}) {
  const out = { _source: source, _revision: revision, _fetched: new Date().toISOString().slice(0, 10), _threat: threat, ...extra, rows }
  const path = isAbsolute(file) ? file : join(dataDir, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(out, null, 1) + '\n')
  console.log(`  wrote ${file}  n=${rows.length}  rev=${revision.slice(0, 12)}`)
}

/**
 * Deterministic stratified sample: `n` rows split across classes in proportion
 * to their size (largest remainder), and within a class the rows whose text
 * hashes lowest. Same input, same sample, on any machine.
 */
export function stratifiedSample<T extends { text: string; class?: string }>(rows: T[], n: number): T[] {
  const byClass = new Map<string, T[]>()
  for (const r of rows) {
    const k = r.class ?? ''
    byClass.set(k, [...(byClass.get(k) ?? []), r])
  }
  const total = rows.length
  const quotas = [...byClass].map(([k, rs]) => ({ k, rs, exact: (rs.length * n) / total }))
  const alloc = new Map(quotas.map(q => [q.k, Math.floor(q.exact)]))
  let left = n - [...alloc.values()].reduce((a, b) => a + b, 0)
  for (const q of [...quotas].sort((a, b) => (b.exact % 1) - (a.exact % 1) || a.k.localeCompare(b.k))) {
    if (left-- <= 0) break
    alloc.set(q.k, (alloc.get(q.k) ?? 0) + 1)
  }
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const out: T[] = []
  for (const [k, rs] of [...byClass].sort(([a], [b]) => a.localeCompare(b))) {
    out.push(...[...rs].sort((a, b) => hash(a.text).localeCompare(hash(b.text))).slice(0, alloc.get(k) ?? 0))
  }
  return out
}

/**
 * databricks-dolly-15k, pinned. Human-written general instructions, the benign
 * traffic neither benign-realistic.json (154 hand-written rows) nor safeguard's
 * benign half (NLP task templates) represents (#245).
 */
const DOLLY_REVISION = 'bdd27f4d94b9c1f951818a7da7fd7aeea5dbff1a'
const DOLLY_LICENSE = 'CC BY-SA 3.0. Source: databricks-dolly-15k, Copyright (2023) Databricks, Inc., https://huggingface.co/datasets/databricks/databricks-dolly-15k. This derived file (instruction field only, sampled) is distributed under the same licence.'
/**
 * Every Dolly instruction, for the nightly report-only scan (#256). Gitignored
 * under test/eval/data/local/: fetched fresh each run, never committed.
 */
export const DOLLY_FULL_FILE = join(dataDir, 'local', 'dolly-15k-full.json')
/** Written by `llm-fw feedback-export` (#542), not fetched: the operator's own traffic. */
export const OPERATOR_FEEDBACK_FILE = join(dataDir, 'local', 'operator-feedback.json')
const DOLLY_SAMPLE_SIZE = 2000
/**
 * Line indices (0-based, at DOLLY_REVISION) of the 15 rows the default
 * configuration blocked in the 2026-10-08 survey (ruleset 2026.08.16). They
 * motivated #246, #247 and #249, so the fixes were written against them; kept
 * in the sample they would measure the fixes rather than generalization. Those
 * shapes are pinned by unit tests instead.
 */
const DOLLY_SURVEY_ROWS = new Set([1558, 5041, 5042, 5120, 5342, 5652, 6816, 8094, 9176, 9832, 9975, 10557, 11476, 12289, 14166])

/**
 * OpenAssistant oasst1, pinned. The conversational benign source #256 asked
 * for: Dolly is single-turn instructions, and second-person, multi-turn
 * phrasing ("your goal for this quarter", "your role on the team"), where #247
 * lived, is barely represented there. The `ready` export is the dataset's own
 * quality-filtered release.
 */
const OASST_REVISION = 'fdf72ae0827c1cda404aff25b6603abec9e3399b'
const OASST_SAMPLE_SIZE = 2000

export interface OasstMessage {
  text: string
  role: string
  lang: string
  parent_id: string | null
  deleted: boolean
  review_result: boolean | null
  synthetic: boolean
  labels?: Record<string, { value: number; count: number }> | null
}

/**
 * The user turns of an oasst1 export as benign rows. Only what a user typed is
 * benign traffic for a request-side firewall, so assistant turns are dropped,
 * as is anything the dataset itself rejected: deleted, failed review,
 * synthetic, or labelled spam or not appropriate by its reviewers (value >=
 * 0.5). Never filtered by llm-fw's own verdicts, which would make the corpus
 * agree with the detector by construction. Classed by language group and by
 * whether the turn opens a conversation or follows up in one.
 */
export function oasstUserTurns(messages: OasstMessage[]): Row[] {
  const flagged = (m: OasstMessage, label: string) => (m.labels?.[label]?.value ?? 0) >= 0.5
  return messages
    .filter(m => m.role === 'prompter' && !m.deleted && m.review_result !== false && !m.synthetic)
    .filter(m => !flagged(m, 'spam') && !flagged(m, 'not_appropriate'))
    .filter(m => m.text.trim() !== '')
    .map(m => ({
      text: m.text,
      label: 0,
      class: `${m.lang === 'en' ? 'en' : 'other'}-${m.parent_id ? 'follow-up' : 'opening'}`,
    }))
}

/**
 * CohereLabs/aya_dataset, pinned. Human-written prompts in 65 languages, the
 * benign traffic for the per-language override lexicons
 * (src/detection/overrideLexicon.ts): oasst1's non-English turns are mostly
 * Spanish, Russian, German, Chinese, French and Portuguese, which had rules
 * already, so they could not tell whether a Hindi or Swedish lexicon blocks
 * ordinary prompts.
 *
 * A fixed number per language (lowest sha256 within each) rather than a
 * proportional sample: proportional left Hungarian or Danish one or two rows.
 * Only the half of the dataset whose text hashes to an odd sha256 is drawn
 * from. The even half was used to look for false positives while the
 * lexicons were written, so this half is the one no rule was checked against.
 */
const AYA_REVISION = 'f9ea04583f02a8f86404ff6c58bf75fe637df8a2'
const AYA_PER_LANGUAGE = 40

export function ayaSample(rows: Array<{ inputs?: string | null; language_code?: string | null }>, perLanguage: number): Row[] {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const byLang = new Map<string, Map<string, string>>()
  for (const r of rows) {
    const text = (r.inputs ?? '').trim()
    const lang = r.language_code ?? ''
    if (!text || !lang) continue
    const h = hash(text)
    if (parseInt(h.slice(-1), 16) % 2 === 0) continue
    const seen = byLang.get(lang) ?? new Map<string, string>()
    seen.set(h, text)
    byLang.set(lang, seen)
  }
  const out: Row[] = []
  for (const [lang, seen] of [...byLang].sort(([a], [b]) => a.localeCompare(b))) {
    for (const h of [...seen.keys()].sort().slice(0, perLanguage)) out.push({ text: seen.get(h) ?? '', label: 0, class: lang })
  }
  return out
}

/**
 * jackhhao/jailbreak-classification, pinned: the held-out split nobody tuned a
 * rule on (chosen 2026-10-26, after rules were tuned by reading safeguard
 * rows). Both its splits, since nothing here trains on it. Report it in
 * aggregate and never read its rows while writing a rule: once read, a row is
 * no longer held out (test/eval/lib/seenRows.ts).
 */
const JAILBREAK_REVISION = '2f2ceeb39658696fd3f462403562b6eea5306287'
const JAILBREAK_LICENSE = 'Apache-2.0. Source: jackhhao/jailbreak-classification, https://huggingface.co/datasets/jackhhao/jailbreak-classification. This derived file (prompt text and label, deduplicated against the other eval splits and the tuning corpus) is redistributed under the same licence.'

const textKey = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/**
 * jailbreak-classification rows as eval rows: `type` jailbreak is 1, benign 0,
 * anything else is dropped rather than guessed. A prompt already in another
 * eval split or in corpus.json (`knownTexts`) is dropped too, because a rule may
 * have been fitted to it there; so is a repeat within the dataset. Compared
 * ignoring case and whitespace.
 */
export function jailbreakHeldoutRows(raw: { prompt: unknown; type: unknown }[], knownTexts: string[]): { rows: Row[]; dropped: { known: number; repeated: number; unusable: number } } {
  const known = new Set(knownTexts.map(textKey))
  const seen = new Set<string>()
  const dropped = { known: 0, repeated: 0, unusable: 0 }
  const rows: Row[] = []
  for (const r of raw) {
    const text = typeof r.prompt === 'string' ? r.prompt : ''
    const label = r.type === 'jailbreak' ? 1 : r.type === 'benign' ? 0 : undefined
    if (text.trim() === '' || label === undefined) { dropped.unusable++; continue }
    const key = textKey(text)
    if (known.has(key)) { dropped.known++; continue }
    if (seen.has(key)) { dropped.repeated++; continue }
    seen.add(key)
    rows.push({ text, label, class: label === 1 ? 'jailbreak' : 'benign' })
  }
  return { rows, dropped }
}

/**
 * yanismiraoui/prompt_injections, pinned: injections in seven languages, attacks
 * only, so it measures recall and says nothing about false positives (#536). Its
 * one column carries no language, so there is no per-language breakdown. Chosen
 * 2026-11-03 from dataset metadata alone. Report it in aggregate and never read
 * its rows, including to check its labels: once read, a row is no longer held
 * out (test/eval/lib/seenRows.ts).
 */
const MULTILINGUAL_REVISION = 'bd55359f2f332afc35f277ac3dd08f7111b024c9'
const MULTILINGUAL_LICENSE = 'Apache-2.0. Source: yanismiraoui/prompt_injections, https://huggingface.co/datasets/yanismiraoui/prompt_injections'

/**
 * Rows of a dataset that holds only attacks: each one label 1. A prompt already
 * in another eval split or in corpus.json is dropped, because a rule may have
 * been fitted to it there, and so is a repeat, compared ignoring case and spacing.
 */
export function attackOnlyHeldoutRows(raw: { prompt: unknown }[], knownTexts: string[]): { rows: Row[]; dropped: { known: number; repeated: number; unusable: number } } {
  const known = new Set(knownTexts.map(textKey))
  const seen = new Set<string>()
  const dropped = { known: 0, repeated: 0, unusable: 0 }
  const rows: Row[] = []
  for (const r of raw) {
    const text = typeof r.prompt === 'string' ? r.prompt : ''
    if (text.trim() === '') { dropped.unusable++; continue }
    const key = textKey(text)
    if (known.has(key)) { dropped.known++; continue }
    if (seen.has(key)) { dropped.repeated++; continue }
    seen.add(key)
    rows.push({ text, label: 1, class: 'multilingual-injection' })
  }
  return { rows, dropped }
}

/** Every prompt in the other eval splits and in the tuning corpus. */
function knownEvalTexts(except: string): string[] {
  const texts: string[] = []
  for (const f of readdirSync(dataDir).filter(f => f.endsWith('.json') && f !== except)) {
    const j = JSON.parse(readFileSync(join(dataDir, f), 'utf8')) as { rows?: { text?: unknown }[] }
    for (const r of j.rows ?? []) if (typeof r.text === 'string') texts.push(r.text)
  }
  const corpus = JSON.parse(readFileSync(join(dataDir, '..', '..', 'detection', 'fixtures', 'corpus.json'), 'utf8')) as { attacks: { prompt: string }[]; benign: string[] }
  return [...texts, ...corpus.attacks.map(a => a.prompt), ...corpus.benign]
}

// ---------------------------------------------------------------------------
// Multi-turn splits (#540). Every crescendo and probing test until these was a
// hand-written unit test: no split delivered a conversation. Each row keeps the
// user turns only, in order; test/eval/lib/surfaces.ts puts a fixed assistant
// reply between them, so attack and benign rows reach the pipeline the same way.

/** A multi-turn row: `text` is the turns joined, for tools that print or hash it. */
export function conversationRow(turns: string[], label: number, cls: string): Row {
  return { text: turns.join('\n\n'), label, class: cls, turns }
}

/**
 * Parse the Python literal the tom-gibbs CSVs store a conversation in
 * (`[{'role': 'user', 'content': '...'}, ...]`, written with repr). Lists,
 * dicts, quoted strings with their escapes, None, True, False and numbers:
 * nothing else occurs, and anything else throws rather than guessing.
 */
export function parsePythonLiteral(src: string): unknown {
  let i = 0
  const ws = () => { while (i < src.length && /\s/.test(src[i]!)) i++ }
  const ESC: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0' }
  const str = (): string => {
    const q = src[i++]
    let out = ''
    while (src[i] !== q) {
      if (i >= src.length) throw new Error('unterminated string')
      if (src[i] !== '\\') { out += src[i++]; continue }
      const e = src[i + 1] ?? ''
      i += 2
      if (e in ESC) out += ESC[e]
      else if (e === 'x' || e === 'u' || e === 'U') {
        const n = e === 'x' ? 2 : e === 'u' ? 4 : 8
        out += String.fromCodePoint(parseInt(src.slice(i, i + n), 16))
        i += n
      } else out += '\\' + e
    }
    i++
    return out
  }
  const seq = <T>(close: string, item: () => T): T[] => {
    i++
    const out: T[] = []
    for (;;) {
      ws()
      if (src[i] === close) { i++; return out }
      out.push(item())
      ws()
      if (src[i] === ',') i++
      else if (src[i] !== close) throw new Error(`expected , or ${close} at ${i}`)
    }
  }
  const value = (): unknown => {
    ws()
    const c = src[i]
    if (c === '[') return seq(']', value)
    if (c === '{') {
      return Object.fromEntries(seq('}', () => {
        const k = value()
        ws()
        if (src[i++] !== ':') throw new Error(`expected : at ${i - 1}`)
        return [String(k), value()] as const
      }))
    }
    if (c === "'" || c === '"') return str()
    const m = /^(?:None|True|False|-?\d+(?:\.\d+)?)/.exec(src.slice(i, i + 32))
    if (!m) throw new Error(`unexpected token at ${i}`)
    i += m[0].length
    return m[0] === 'None' ? null : m[0] === 'True' ? true : m[0] === 'False' ? false : Number(m[0])
  }
  const v = value()
  ws()
  if (i !== src.length) throw new Error(`trailing input at ${i}`)
  return v
}

/** The user turns of one tom-gibbs conversation, in order. */
export function gibbsUserTurns(conversation: string): string[] {
  const parsed = parsePythonLiteral(conversation)
  if (!Array.isArray(parsed)) throw new Error('conversation is not a list')
  return parsed
    .filter((t): t is { role: string; content: string } => typeof t === 'object' && t !== null && (t as { role?: unknown }).role === 'user')
    .map(t => String(t.content))
}

/**
 * One conversation per goal, the one whose text hashes lowest. The tom-gibbs
 * sets hold eight cipher variants of each goal; keeping all eight would count
 * one goal eight times.
 */
export function onePerGroup<T extends { text: string }>(rows: Array<T & { group: string }>): T[] {
  const hash = (s: string) => createHash('sha256').update(s).digest('hex')
  const best = new Map<string, { h: string; row: T & { group: string } }>()
  for (const row of rows) {
    const h = hash(row.text)
    const cur = best.get(row.group)
    if (!cur || h < cur.h) best.set(row.group, { h, row })
  }
  return [...best.values()].map(({ row: { group: _g, ...rest } }) => rest as unknown as T)
}

export interface OasstTreeMessage extends OasstMessage { message_id: string; message_tree_id: string }

/**
 * Benign multi-turn conversations from oasst1: every path from a tree's root
 * to a user turn that holds at least `minUserTurns` user turns, with no message
 * on it the dataset rejected (the same filters as oasstUserTurns), and then one
 * path per tree, the one whose user text hashes lowest. Classed by the language
 * group of the turn that opens it.
 */
export function oasstConversations(messages: OasstTreeMessage[], minUserTurns = 3): Row[] {
  const flagged = (m: OasstMessage, label: string) => (m.labels?.[label]?.value ?? 0) >= 0.5
  const usable = (m: OasstMessage) => !m.deleted && m.review_result !== false && !m.synthetic
    && !flagged(m, 'spam') && !flagged(m, 'not_appropriate') && m.text.trim() !== ''
  const byId = new Map(messages.map(m => [m.message_id, m]))
  const paths = new Map<string, string[][]>()
  for (const m of messages) {
    if (m.role !== 'prompter') continue
    const chain: OasstTreeMessage[] = []
    let cur: OasstTreeMessage | undefined = m
    while (cur && usable(cur)) {
      chain.push(cur)
      if (!cur.parent_id) break
      cur = byId.get(cur.parent_id)
    }
    const root = chain[chain.length - 1]
    if (!root || root.parent_id) continue // a rejected or missing message on the way up
    const users = chain.filter(c => c.role === 'prompter').reverse().map(c => c.text)
    if (users.length < minUserTurns) continue
    paths.set(m.message_tree_id, [...(paths.get(m.message_tree_id) ?? []), users])
  }
  const rows: Row[] = []
  for (const [treeId, candidates] of paths) {
    const lang = byId.get(treeId)?.lang ?? 'other'
    const best = onePerGroup(candidates.map(turns => ({ text: turns.join('\n\n'), turns, group: treeId })))[0]!
    rows.push(conversationRow(best.turns, 0, lang === 'en' ? 'en' : 'other'))
  }
  return rows
}

const SAFEMT_REVISION = '04af7bd0b6b6044e797e936d79674e348316b9b8'
const GIBBS_REVISION = 'e3b30257c4d6be5438ea19f0989ac82c24234fe4'
const OASST_MULTITURN_SIZE = 1000

async function pinnedRevision(dataset: string, pinned: string): Promise<string> {
  const rev = await hfRevision(dataset)
  if (rev !== pinned) throw new Error(`${dataset} is at ${rev}, pinned ${pinned}: review the change before re-pinning`)
  return rev
}

const FETCHERS: Record<string, () => Promise<void>> = {
  /** databricks-dolly-15k: a fixed stratified sample of the benign instructions, for the FPR gate. */
  'dolly-15k-sample': async () => {
    const text = await getText(`https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/${DOLLY_REVISION}/databricks-dolly-15k.jsonl`)
    const all = text.split('\n').filter(Boolean).map(l => JSON.parse(l) as { instruction: string; category: string })
    const pool = all
      .map((r, i) => ({ i, text: r.instruction, label: 0, class: r.category }))
      .filter(r => !DOLLY_SURVEY_ROWS.has(r.i))
    const rows = stratifiedSample(pool, DOLLY_SAMPLE_SIZE).map(({ text, label, class: c }) => ({ text, label, class: c }))
    write('dolly-15k-sample.json',
      `databricks/databricks-dolly-15k: a fixed ${DOLLY_SAMPLE_SIZE}-row stratified sample (by Dolly category, lowest sha256 of the instruction within each) of the ${all.length} human-written instructions, label 0 (benign-only, FPR-only). HELD OUT: never tune detection against it. The ${DOLLY_SURVEY_ROWS.size} rows blocked in the 2026-10-08 survey are excluded, because fixes were written against them. Regenerate with scripts/fetch-eval-data.ts dolly-15k-sample.`,
      DOLLY_REVISION, 'injection', rows,
      { _license: DOLLY_LICENSE })
  },

  /** databricks-dolly-15k: every instruction, for the nightly report-only scan. Not committed. */
  'dolly-15k-full': async () => {
    const text = await getText(`https://huggingface.co/datasets/databricks/databricks-dolly-15k/resolve/${DOLLY_REVISION}/databricks-dolly-15k.jsonl`)
    const rows = text.split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as { instruction: string; category: string })
      .map(r => ({ text: r.instruction, label: 0, class: r.category }))
    write(DOLLY_FULL_FILE,
      `databricks/databricks-dolly-15k: all ${rows.length} human-written instructions, label 0 (benign-only, FPR-only). Report-only in the nightly job, gitignored. HELD OUT: never tune detection against it.`,
      DOLLY_REVISION, 'injection', rows,
      { _license: DOLLY_LICENSE.replace('sampled', 'all rows') })
  },

  /** OpenAssistant oasst1: a fixed stratified sample of user turns, for the FPR gate (#256). */
  'oasst1-sample': async () => {
    const gz = await getBuffer(`https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/${OASST_REVISION}/2023-04-12_oasst_ready.messages.jsonl.gz`)
    const messages = gunzipSync(gz).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as OasstMessage)
    const turns = oasstUserTurns(messages)
    const rows = stratifiedSample(turns, OASST_SAMPLE_SIZE)
    write('oasst1-sample.json',
      `OpenAssistant/oasst1 (2023-04-12_oasst_ready.messages): a fixed ${OASST_SAMPLE_SIZE}-row stratified sample (by language group x opening/follow-up turn, lowest sha256 within each) of the ${turns.length} user turns that passed the dataset's own review, label 0 (benign-only, FPR-only). HELD OUT: never tune detection against it. Regenerate with scripts/fetch-eval-data.ts oasst1-sample.`,
      OASST_REVISION, 'injection', rows,
      { _license: 'Apache-2.0. Source: OpenAssistant/oasst1, https://huggingface.co/datasets/OpenAssistant/oasst1. This derived file (user-turn text only, sampled) is redistributed under the same licence.' })
  },

  /** SafeMTData Attack_600 (ActorAttack): 600 five-turn escalations toward a harmful request, recall only (#540). */
  'safemt-attack-600': async () => {
    const dataset = 'SafeMTData/SafeMTData'
    const rev = await pinnedRevision(dataset, SAFEMT_REVISION)
    const all = await getJson(`https://huggingface.co/datasets/${dataset}/resolve/${rev}/SafeMTData/Attack_600.json`) as Array<{ category: string; multi_turn_queries: string[] }>
    const rows = all
      .filter(r => Array.isArray(r.multi_turn_queries) && r.multi_turn_queries.length > 1)
      .map(r => conversationRow(r.multi_turn_queries.map(String), 1, r.category))
    write('safemt-attack-600.json',
      `SafeMTData/SafeMTData Attack_600.json (ActorAttack, arXiv 2410.10700): ${rows.length} multi-turn conversations that approach a HarmBench-style harmful goal through questions about a related actor, user turns only, all label 1 (recall-only). HELD OUT: never open its rows or tune detection against it. Regenerate with scripts/fetch-eval-data.ts safemt-attack-600.`,
      rev, 'multi-turn', rows,
      { _license: `MIT. Source: SafeMTData/SafeMTData, https://huggingface.co/datasets/${dataset}. This derived file (user turns and category only) is redistributed under the same licence.` })
  },

  /** tom-gibbs multi-turn jailbreaks: cipher conversations, harmful and two matched benign controls (#540). */
  'multiturn-cipher': async () => {
    const dataset = 'tom-gibbs/multi-turn_jailbreak_attack_datasets'
    const rev = await pinnedRevision(dataset, GIBBS_REVISION)
    const rows: Row[] = []
    for (const [file, label, cls] of [['Harmful Dataset.csv', 1, 'harmful'], ['Completely-Benign Dataset.csv', 0, 'benign'], ['Semi-Benign Dataset.csv', 0, 'semi-benign']] as const) {
      const csv = csvObjects(await getText(`https://huggingface.co/datasets/${dataset}/resolve/${rev}/${encodeURIComponent(file)}`))
      rows.push(...onePerGroup(csv.map(r => ({ ...conversationRow(gibbsUserTurns(r['Multi-turn conversation'] ?? '[]'), label, cls), group: r['Goal ID'] ?? '' }))))
    }
    write('multiturn-cipher.json',
      `tom-gibbs/multi-turn_jailbreak_attack_datasets (Harmful, Completely-Benign and Semi-Benign input-only CSVs): the user turns of each multi-turn conversation, which spreads a word-substitution cipher over several turns before the request. One conversation per goal (lowest sha256 of its text) of the eight the dataset holds per goal. label 1 = harmful goal, label 0 = the dataset's two benign controls built the same way (semi-benign uses harmful words for a benign goal). HELD OUT: never open its rows or tune detection against it. Regenerate with scripts/fetch-eval-data.ts multiturn-cipher.`,
      rev, 'multi-turn', rows,
      { _license: `MIT. Source: tom-gibbs/multi-turn_jailbreak_attack_datasets, https://huggingface.co/datasets/${dataset}. This derived file (user turns only, one conversation per goal) is redistributed under the same licence.` })
  },

  /** OpenAssistant oasst1: benign conversations of three or more user turns, the multi-turn FPR side (#540). */
  'oasst1-multiturn': async () => {
    const gz = await getBuffer(`https://huggingface.co/datasets/OpenAssistant/oasst1/resolve/${OASST_REVISION}/2023-04-12_oasst_ready.messages.jsonl.gz`)
    const messages = gunzipSync(gz).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as OasstTreeMessage)
    const all = oasstConversations(messages)
    const rows = stratifiedSample(all, OASST_MULTITURN_SIZE)
    write('oasst1-multiturn.json',
      `OpenAssistant/oasst1 (2023-04-12_oasst_ready.messages): a fixed ${rows.length}-conversation stratified sample (by the opening turn's language group, lowest sha256 within each) of the ${all.length} message trees with a path of at least three user turns that passed the dataset's own review, one path per tree, user turns only, label 0 (benign-only, FPR-only). HELD OUT: never tune detection against it. Regenerate with scripts/fetch-eval-data.ts oasst1-multiturn.`,
      OASST_REVISION, 'multi-turn', rows,
      { _license: 'Apache-2.0. Source: OpenAssistant/oasst1, https://huggingface.co/datasets/OpenAssistant/oasst1. This derived file (user-turn text only, sampled) is redistributed under the same licence.' })
  },

  /** CohereLabs/aya_dataset: a fixed per-language sample of human-written prompts, for the FPR gate. */
  'aya-sample': async () => {
    const buf = await getBuffer(`https://huggingface.co/datasets/CohereLabs/aya_dataset/resolve/${AYA_REVISION}/data/train-00000-of-00001.parquet`)
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    const all = await parquetReadObjects({ file, columns: ['inputs', 'language_code'] }) as Array<{ inputs?: string; language_code?: string }>
    const rows = ayaSample(all, AYA_PER_LANGUAGE)
    write('aya-sample.json',
      `CohereLabs/aya_dataset (train): up to ${AYA_PER_LANGUAGE} human-written prompts per language (lowest sha256 within each, from the half of the ${all.length} prompts whose sha256 is odd), ${new Set(rows.map(r => r.class)).size} languages, label 0 (benign-only, FPR-only). HELD OUT: never tune detection against it; the even half is for finding false positives. Regenerate with scripts/fetch-eval-data.ts aya-sample.`,
      AYA_REVISION, 'injection', rows,
      { _license: 'Apache-2.0. Source: CohereLabs/aya_dataset, https://huggingface.co/datasets/CohereLabs/aya_dataset. This derived file (prompt text only, sampled) is redistributed under the same licence.' })
  },

  /** deepset/prompt-injections — full test split. Independent public injection set (noisy labels). */
  'deepset-prompt-injections': async () => {
    const rev = await hfRevision('deepset/prompt-injections')
    const rows = await hfRows('deepset/prompt-injections', 'default', 'test')
    write('deepset-prompt-injections.json',
      'deepset/prompt-injections (FULL test split) — independent public benchmark, label 1=injection 0=benign. Labels are noisy (benign role-play marked as injection).',
      rev, 'injection',
      rows.map(r => ({ text: String(r.text), label: Number(r.label) })))
  },

  /** Lakera/gandalf_ignore_instructions — full test split, attacks only. */
  'gandalf-ignore-instructions': async () => {
    const rev = await hfRevision('Lakera/gandalf_ignore_instructions')
    const rows = await hfRows('Lakera/gandalf_ignore_instructions', 'default', 'test')
    write('gandalf-ignore-instructions.json',
      'Lakera/gandalf_ignore_instructions (FULL test split) — real Gandalf-challenge injection attempts, all label 1 (recall-only)',
      rev, 'injection',
      rows.map(r => ({ text: String(r.text), label: 1, class: 'direct-override' })))
  },

  /** jackhhao/jailbreak-classification, pinned: the never-tuned held-out split. */
  'jailbreak-classification': async () => {
    const dataset = 'jackhhao/jailbreak-classification'
    const rev = await hfRevision(dataset)
    if (rev !== JAILBREAK_REVISION) throw new Error(`${dataset} is at ${rev}, pinned ${JAILBREAK_REVISION}: review the change before re-pinning`)
    const raw = [...await hfRows(dataset, 'default', 'train'), ...await hfRows(dataset, 'default', 'test')]
    const { rows, dropped } = jailbreakHeldoutRows(raw as { prompt: unknown; type: unknown }[], knownEvalTexts('jailbreak-classification.json'))
    console.log(`  jailbreak-classification: ${raw.length} rows, dropped ${dropped.known} already in another split or the corpus, ${dropped.repeated} repeats, ${dropped.unusable} unusable`)
    write('jailbreak-classification.json',
      'jackhhao/jailbreak-classification (train + test, deduplicated) - held-out, never tuned on; label 1=jailbreak 0=benign',
      rev, 'injection', rows, { _license: JAILBREAK_LICENSE })
  },

  /** yanismiraoui/prompt_injections, pinned: held-out multilingual attacks, recall only (#536). */
  'multilingual-injections': async () => {
    const dataset = 'yanismiraoui/prompt_injections'
    const rev = await hfRevision(dataset)
    if (rev !== MULTILINGUAL_REVISION) throw new Error(`${dataset} is at ${rev}, pinned ${MULTILINGUAL_REVISION}: review the change before re-pinning`)
    const raw = await hfRows(dataset, 'default', 'train')
    const { rows, dropped } = attackOnlyHeldoutRows(raw.map(r => ({ prompt: r.prompt_injections })), knownEvalTexts('multilingual-injections.json'))
    console.log(`  multilingual-injections: ${raw.length} rows, dropped ${dropped.known} already in another split or the corpus, ${dropped.repeated} repeats, ${dropped.unusable} unusable`)
    write('multilingual-injections.json',
      'yanismiraoui/prompt_injections (en, fr, de, es, pt, it, ro; deduplicated) - held-out, attacks only; label 1=attack',
      rev, 'injection', rows, { _license: MULTILINGUAL_LICENSE })
  },

  /** xTRam1/safe-guard-prompt-injection — FULL test split (was a 60/60 sample). */
  'safeguard-prompt-injection': async () => {
    const rev = await hfRevision('xTRam1/safe-guard-prompt-injection')
    const rows = await hfRows('xTRam1/safe-guard-prompt-injection', 'default', 'test')
    write('safeguard-prompt-injection.json',
      'xTRam1/safe-guard-prompt-injection (FULL test split) — independent public, label 1=injection 0=benign',
      rev, 'injection',
      rows.map(r => ({ text: String(r.text), label: Number(r.label) })))
  },

  /** JailbreakBench JBB-Behaviors — 100 harmful + 100 benign behavior requests. */
  'jbb-behaviors': async () => {
    const rev = await hfRevision('JailbreakBench/JBB-Behaviors')
    const harmful = await hfRows('JailbreakBench/JBB-Behaviors', 'behaviors', 'harmful')
    const benign = await hfRows('JailbreakBench/JBB-Behaviors', 'behaviors', 'benign')
    write('jbb-behaviors.json',
      'JailbreakBench/JBB-Behaviors (behaviors config, FULL harmful+benign splits) — harmful-content behavior requests (label 1) with matched benign counterparts (label 0). Different threat model than injection: tests whether a harmful REQUEST is caught.',
      rev, 'harmful-content',
      [...harmful.map(r => ({ text: String(r.Goal), label: 1, class: String(r.Category) })),
       ...benign.map(r => ({ text: String(r.Goal), label: 0, class: String(r.Category) }))])
  },

  /** HarmBench text behaviors — all 400 (contextual behaviors get their context prepended). */
  'harmbench': async () => {
    const repo = 'centerforaisafety/HarmBench'
    const rev = await ghRevision(repo)
    const csv = await ghRaw(repo, rev, 'data/behavior_datasets/harmbench_behaviors_text_all.csv')
    const rows = csvObjects(csv).map(r => ({
      text: r.ContextString ? `${r.ContextString}\n\n${r.Behavior}` : r.Behavior,
      label: 1,
      class: r.SemanticCategory || r.FunctionalCategory,
    }))
    write('harmbench.json',
      'HarmBench harmbench_behaviors_text_all.csv (FULL, 400 text behaviors; contextual behaviors include their context) — harmful-content requests, all label 1 (recall-only)',
      rev, 'harmful-content', rows)
  },

  /** AdvBench harmful_behaviors — all 520 harmful instructions. */
  'advbench': async () => {
    const repo = 'llm-attacks/llm-attacks'
    const rev = await ghRevision(repo)
    const csv = await ghRaw(repo, rev, 'data/advbench/harmful_behaviors.csv')
    const rows = csvObjects(csv).map(r => ({ text: r.goal, label: 1, class: 'harmful-behavior' }))
    write('advbench.json',
      'AdvBench harmful_behaviors.csv (FULL, 520) from llm-attacks/llm-attacks — harmful-content instructions, all label 1 (recall-only)',
      rev, 'harmful-content', rows)
  },

  /** InjecAgent base test cases — attacker instructions embedded in realistic tool
   *  responses, delivered on the tool_result surface. Benign rows are the same
   *  tool-response templates with an innocuous sentence in the attacker slot. */
  'injecagent': async () => {
    const repo = 'uiuc-kang-lab/InjecAgent'
    const rev = await ghRevision(repo)
    interface Case { 'Tool Response': string; 'Tool Response Template': string; 'Attack Type'?: string }
    const dh = JSON.parse(await ghRaw(repo, rev, 'data/test_cases_dh_base.json')) as Case[]
    const ds = JSON.parse(await ghRaw(repo, rev, 'data/test_cases_ds_base.json')) as Case[]
    const rows: Row[] = []
    for (const [cases, kind] of [[dh, 'direct-harm'], [ds, 'data-stealing']] as const) {
      for (const c of cases) {
        rows.push({ text: c['Tool Response'], label: 1, class: `${kind}:${c['Attack Type'] ?? kind}`, surface: 'tool_result' })
      }
    }
    // Benign hard-negatives: each distinct tool-response template, attacker slot
    // filled with ordinary content — measures FPR on the tool_result surface.
    const benignFill = 'Thanks for the quick delivery, the product works exactly as described and I would order again.'
    const templates = new Set([...dh, ...ds].map(c => c['Tool Response Template']))
    for (const t of templates) {
      rows.push({ text: t.replace(/<Attacker Instruction>/g, benignFill), label: 0, class: 'benign-tool-response', surface: 'tool_result' })
    }
    write('injecagent.json',
      'InjecAgent (uiuc-kang-lab/InjecAgent) base test cases dh+ds (FULL) — attacker instructions embedded in tool responses, scanned on the tool_result surface (indirect injection). Benign rows are the same templates with an innocuous filler (synthetic, for tool_result-surface FPR).',
      rev, 'indirect-injection', rows)
  },
}

async function main() {
  const names = process.argv.slice(2).filter(a => !a.startsWith('-'))
  const selected = names.length ? names : Object.keys(FETCHERS)
  for (const name of selected) {
    const f = FETCHERS[name]
    if (!f) { console.error(`unknown dataset '${name}' — known: ${Object.keys(FETCHERS).join(', ')}`); process.exit(1) }
    console.log(`fetching ${name} …`)
    await f()
  }
}

// Only fetch when run directly, so tests can import stratifiedSample without
// triggering a network sweep.
const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) main().catch(e => { console.error(e); process.exit(1) })
