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
 *     rows: [{ text, label, class?, surface? }]
 *   }
 *
 * label 1=attack 0=benign. `surface: 'tool_result'` makes the benchmark
 * harness deliver the text as an Anthropic tool_result block instead of a
 * user prompt (exercises the indirect-injection scan path).
 *
 * Usage:  node --import tsx/esm scripts/fetch-eval-data.ts [name ...]
 *         (no args = fetch all; names = subset, e.g. `jbb-behaviors harmbench`)
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const dataDir = join(__dir, '..', 'test', 'eval', 'data')

interface Row { text: string; label: number; class?: string; surface?: 'tool_result' }
type Threat = 'injection' | 'harmful-content' | 'indirect-injection'

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

function write(file: string, source: string, revision: string, threat: Threat, rows: Row[]) {
  const out = { _source: source, _revision: revision, _fetched: new Date().toISOString().slice(0, 10), _threat: threat, rows }
  writeFileSync(join(dataDir, file), JSON.stringify(out, null, 1) + '\n')
  console.log(`  wrote ${file}  n=${rows.length}  rev=${revision.slice(0, 12)}`)
}

// ---------------------------------------------------------------------------

const FETCHERS: Record<string, () => Promise<void>> = {
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

main().catch(e => { console.error(e); process.exit(1) })
