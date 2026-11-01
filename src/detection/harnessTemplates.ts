// Fixed prompt templates that agent harnesses send as a user turn, with the
// work they want done appended. Their wording is the harness's, not anyone's
// input, and it can score as an attack on its own: Claude Code's background
// security review opens with instructions naming SQL injection, hardcoded
// passwords and eval(), and the harmful-request stage refused every such
// review on that text alone (8 events in the live ring on 2026-11-01,
// whichever repository was reviewed).
//
// A text that starts with a registered template is scored without it, on
// every stage: only the template's own fixed characters go, and everything
// after it (the diff, the files, the task) is scored in full. A slot holds a
// bounded word, never a sentence. A text that differs from a template by one
// character, or carries a sentence in a slot, is scored whole, as before.
// Because nothing but fixed text is ever removed, faking a template gains an
// attacker nothing, so a template is not tied to the client that sends it:
// the security review above arrives without Claude Code's User-Agent.
//
// Adding a template: copy its fixed text exactly from a real request (the
// dashboard's event payload), replace each part that varies with a slot, and
// add an entry below. Find candidates by grouping the dashboard's refused and
// warned events by a long passage they share across different requests: a
// template repeats, the work appended to it does not. test/detection/harnessTemplates.test.ts walks the list
// and checks every entry: its text alone passes, an attack appended to it or
// put in a slot still blocks. Each entry changes verdicts, so cut the ruleset.
import type { ScanSource } from '../types.js'
import { sessionInner } from './clientEnvelopes.js'

/** What a slot may hold: nothing a sentence could be made of. */
const SLOT_SHAPES = {
  // One word with no spaces, such as a language name (C++, C#, TypeScript).
  word: '[A-Za-z][A-Za-z0-9+#.-]{0,31}',
  // A list of repository paths, one per line as `  - path`, with no spaces.
  // A path is still scored where the diff names it (`=== DIFF: path ===`).
  paths: '(?:  - [^\\s]{1,400}\\n){1,500}',
} as const

export interface HarnessTemplate {
  /** Stable name for tests and events. */
  id: string
  /** Who sends it and where it was seen; documentation only, never matched. */
  sender: string
  /** Fixed text the user turn starts with. `{{name}}` is a slot, shaped by `slots`. */
  head: string
  /** Fixed text the turn ends with, if the template has any; no slots. */
  tail?: string
  slots?: Record<string, keyof typeof SLOT_SHAPES>
}

export const HARNESS_TEMPLATES: readonly HarnessTemplate[] = [
  {
    id: 'claude-code-security-review',
    sender: 'Claude Code background security review, no Claude Code User-Agent (live, 2026-11-01)',
    head: [
      'You are a security expert reviewing {{language}} diff. Analyze the diff below for CONCRETE security vulnerabilities that an attacker could exploit, applying the vulnerability categories and exclusions above.',
      '',
      'Note: You are reviewing a unified diff. Unmarked lines (starting with a space) are UNCHANGED context — they were already in the file before this session. Lines starting with + are ADDITIONS made in this session. Lines starting with - are REMOVALS.',
      '',
      'CRITICAL: ONLY flag vulnerabilities that are NEWLY INTRODUCED in + lines. Do NOT flag:',
      "- Issues in unmarked context lines (space-prefixed = pre-existing code). Even if a context line contains SECRET_KEY = 'hardcoded', DEBUG=True, hardcoded passwords, SQL injection, or any other vulnerability — it is PRE-EXISTING and must be ignored.",
      '- Issues where the SAME pattern existed in the removed (-) lines and was re-added in + lines (this means the code was rewritten/reformatted but the pattern is pre-existing)',
      '- Pre-existing patterns that Claude simply preserved when rewriting a file',
      '- Any vulnerability whose vulnerable code snippet appears in context (space-prefixed) lines',
      '- Vulnerabilities in the ORIGINAL/STARTER code that the developer was given to work with. If a file was fully rewritten (all lines show as - then +), compare the + content against the - content. Only flag NEWLY INTRODUCED patterns that did NOT exist in the - lines.',
      '- Issues OUTSIDE THE SCOPE of what the developer was asked to do. If the task was "add logging middleware" and the starter code has a hardcoded SECRET_KEY, that is pre-existing and out of scope — do NOT flag it.',
      '',
      'A vulnerability is ONLY new if the + lines introduce a pattern that did NOT exist anywhere in the - lines or context lines of the same file.',
      '',
      'EXCEPTION — data flow to pre-existing sinks: If + lines route user-controlled data to a PRE-EXISTING dangerous sink (like `new Function()`, `eval()`, `exec()`, or shell string interpolation in context lines), this IS a new vulnerability. The sink was already there, but the new code created a new attack path to it. Flag this as a new vulnerability in the + lines.',
      '',
      'For each vulnerability found, provide:',
      '1. The file path where it occurs (use the exact path from the === DIFF: header)',
      '2. The vulnerability category',
      '3. The specific vulnerable code (quote the exact line(s))',
      '4. How an attacker would exploit it',
      '5. A specific code fix',
      '',
      '',
    ].join('\n'),
    tail: 'Respond with a JSON object. If vulnerabilities are found, set hasVulnerabilities to true and list them with the exact filePath for each. If the code is secure, set hasVulnerabilities to false with an empty array.',
    slots: { language: 'word' },
  },
  {
    id: 'claude-code-security-review-agent',
    sender: 'Claude Code security review agent, Claude Code User-Agent, also inside its session-title request (live, 2026-11-01)',
    head: [
      'Review this change for security vulnerabilities.',
      '',
      'Changed files (you may Read these and any other file in the repo):',
      '{{files}}',
      'Unified diff (only + lines are new):',
      '',
      '',
    ].join('\n'),
    tail: 'Investigate per the method in your instructions, then return the findings list.',
    slots: { files: 'paths' },
  },
]

interface Compiled {
  id: string
  /** The head up to its first slot: a cheap check before the regex runs. */
  lead: string
  /** The whole head, sticky at 0: literals and bounded slots, so linear. */
  head: RegExp
  tail: string | undefined
}

const SLOT = /\{\{(\w+)\}\}/g
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function compileTemplate(t: HarnessTemplate): Compiled {
  let source = ''
  let last = 0
  for (const m of t.head.matchAll(SLOT)) {
    const shape = t.slots?.[m[1]!]
    if (!shape) throw new Error(`harness template ${t.id}: slot {{${m[1]}}} has no shape`)
    source += `${escapeRegExp(t.head.slice(last, m.index))}(?:${SLOT_SHAPES[shape]})`
    last = m.index + m[0].length
  }
  source += escapeRegExp(t.head.slice(last))
  const first = t.head.search(SLOT)
  const lead = first < 0 ? t.head : t.head.slice(0, first)
  if (lead.length < 20) throw new Error(`harness template ${t.id}: needs 20 fixed characters before its first slot`)
  return { id: t.id, lead, head: new RegExp(source, 'y'), tail: t.tail }
}

const COMPILED: readonly Compiled[] = HARNESS_TEMPLATES.map(compileTemplate)

/**
 * A user turn without the fixed text of the harness template it starts with,
 * and the template's id; the text unchanged and no id when it starts with none.
 * Only the prompt surface: a tool result or a document is data, and a
 * template's wording there is someone's text.
 *
 * Claude Code also sends a template inside its session-title request, the
 * turn in <session> and a fixed title line after it. That wrapper goes too,
 * but only around a template: a title request around anything else is scored
 * as before. Both are fixed text at the start and end, so what is left is a
 * part of the original text and no rule can match across a cut.
 */
export function stripHarnessTemplate(text: string, source: ScanSource): { text: string; template?: string } {
  if (source !== 'prompt') return { text }
  const direct = stripHead(text)
  if (direct) return direct
  const inner = text.startsWith('<session>') ? sessionInner(text.trim()) : null
  return (inner !== null && stripHead(inner.trim())) || { text }
}

function stripHead(text: string): { text: string; template: string } | null {
  for (const t of COMPILED) {
    if (!text.startsWith(t.lead)) continue
    t.head.lastIndex = 0
    const m = t.head.exec(text)
    if (!m) continue
    let rest = text.slice(m[0].length)
    if (t.tail !== undefined) {
      const trimmed = rest.trimEnd()
      if (trimmed.endsWith(t.tail)) rest = trimmed.slice(0, trimmed.length - t.tail.length)
    }
    return { text: rest, template: t.id }
  }
  return null
}
