import { HeuristicScorer } from '../heuristic.js'
import { HeuristicResult } from '../../types.js'

/** A RAG data block isolated from the surrounding prompt. */
export interface RagContextBlock {
  /** The inner text of the matched block. */
  block: string
  /** Which boundary matched (e.g. 'document', 'context', 'search_results', 'code-fence'). */
  tag: string
}

// Tag-delimited boundaries commonly used to inject retrieved documents into a
// prompt. Each is matched non-greedily and tolerant of a MISSING close tag
// (the close group is optional; if absent we capture to end-of-string). 's'
// flag → '.' spans newlines; 'i' flag → tags are case-insensitive.
const TAG_BLOCKS: { tag: string; re: RegExp }[] = [
  { tag: 'document', re: /<document(?:\s[^>]*)?>([\s\S]*?)(?:<\/document>|$)/gi },
  { tag: 'context', re: /<context(?:\s[^>]*)?>([\s\S]*?)(?:<\/context>|$)/gi },
  { tag: 'search_results', re: /<search_results(?:\s[^>]*)?>([\s\S]*?)(?:<\/search_results>|$)/gi },
  // Also common in LangChain / LlamaIndex retrieval prompts.
  { tag: 'data', re: /<data(?:\s[^>]*)?>([\s\S]*?)(?:<\/data>|$)/gi },
  { tag: 'web_page', re: /<web_page(?:\s[^>]*)?>([\s\S]*?)(?:<\/web_page>|$)/gi },
  { tag: 'source', re: /<source(?:\s[^>]*)?>([\s\S]*?)(?:<\/source>|$)/gi },
]

interface TagSpan { tag: string; start: number; innerStart: number; innerEnd: number; end: number }

/**
 * Every tag block's span. A block runs from its opening tag to the LAST
 * closing tag before the next opening tag of the same name, or to the end of
 * the text when there is none (#919): ended at the first closer, a retrieved
 * document that wrote "</document>" itself put everything after it outside
 * the block, where it read as the user's own text. Found with index scans, so
 * the cost is the text's length.
 */
function tagSpans(prompt: string): TagSpan[] {
  const lower = prompt.toLowerCase()
  const spans: TagSpan[] = []
  for (const { tag } of TAG_BLOCKS) {
    // An opener is "<tag>" or "<tag" then whitespace, any attributes and ">",
    // as the old pattern read it, attributes of any length (security review
    // of #919: a 512-character cap left a longer opener unread). Found with
    // forward scans: the next "<tag", then the next ">", so every character
    // is passed once however many openers lack their ">".
    const open = `<${tag}`
    const closer = `</${tag}>`
    const opens: Array<{ start: number; innerStart: number }> = []
    for (let p = lower.indexOf(open); p !== -1; ) {
      const next = lower.charCodeAt(p + open.length)
      if (next === 0x3e /* > */) {
        opens.push({ start: p, innerStart: p + open.length + 1 })
        p = lower.indexOf(open, p + open.length + 1)
        continue
      }
      if (!/\s/.test(lower[p + open.length] ?? '')) { p = lower.indexOf(open, p + open.length); continue }
      const gt = lower.indexOf('>', p + open.length)
      if (gt === -1) break
      opens.push({ start: p, innerStart: gt + 1 })
      p = lower.indexOf(open, gt + 1)
    }
    if (opens.length === 0) continue
    const closers: number[] = []
    for (let k = lower.indexOf(closer); k !== -1; k = lower.indexOf(closer, k + closer.length)) closers.push(k)
    // Openers never overlap (each match starts where the last ended), so a
    // block's region ends at the next opener; both lists are walked once.
    let c = 0
    for (let i = 0; i < opens.length; i++) {
      const o = opens[i]!
      const limit = opens[i + 1]?.start ?? prompt.length
      while (c < closers.length && closers[c]! < o.innerStart) c++
      let last = -1
      while (c < closers.length && closers[c]! + closer.length <= limit) last = closers[c++]!
      const innerEnd = last === -1 ? limit : last
      const end = last === -1 ? limit : last + closer.length
      spans.push({ tag, start: o.start, innerStart: o.innerStart, innerEnd, end })
    }
  }
  return spans
}

// Triple-backtick fenced code block (GitHub-Flavored-Markdown style): an opening
// fence of 3+ backticks at the start of a line (optionally indented up to 3
// spaces) with an optional info string, content, then a closing fence of at
// least the same length at line start — or end-of-string if the close is
// missing. The leading (?:^|\n) anchors the fence to a line start so backticks
// appearing mid-line (inline code) do not start a block; the \1 backreference
// requires the closing fence to be at least as long as the opening one.
const FENCE_RE = /(?:^|\n)[ \t]{0,3}(`{3,})[^\n`]*\n([\s\S]*?)(?:\n[ \t]{0,3}\1`*[ \t]*(?=\n|$)|$)/g

// Markdown blockquotes — a run of consecutive lines beginning with `>` (a very
// common way LangChain/LlamaIndex inline retrieved snippets). Captured as one
// block; the leading `>` markers are stripped to recover the quoted text.
const BLOCKQUOTE_RE = /(?:^|\n)((?:[ \t]*>[^\n]*(?:\n|$))+)/g

/**
 * Isolate RAG data blocks from a compiled prompt.
 *
 * Recognises `<document>`, `<context>`, `<search_results>` tag boundaries and
 * triple-backtick fenced code blocks. Returns the inner text of every block
 * found plus which boundary matched. Robust to multiple blocks and to a
 * missing close tag/fence (the block is captured to end-of-string).
 *
 * Pure / regex-based — no Ollama dependency, so it is fully unit-testable.
 */
export function extractRagContext(prompt: string): RagContextBlock[] {
  const blocks: RagContextBlock[] = []
  if (!prompt) return blocks

  for (const span of tagSpans(prompt)) {
    const inner = prompt.slice(span.innerStart, span.innerEnd).trim()
    if (inner.length > 0) blocks.push({ block: inner, tag: span.tag })
  }

  FENCE_RE.lastIndex = 0
  for (let f = FENCE_RE.exec(prompt); f !== null; f = FENCE_RE.exec(prompt)) {
    const inner = (f[2] ?? '').trim()
    if (inner.length > 0) blocks.push({ block: inner, tag: 'code-fence' })
    if (f.index === FENCE_RE.lastIndex) FENCE_RE.lastIndex++
  }

  BLOCKQUOTE_RE.lastIndex = 0
  for (let q = BLOCKQUOTE_RE.exec(prompt); q !== null; q = BLOCKQUOTE_RE.exec(prompt)) {
    const inner = (q[1] ?? '')
      .split(/\r?\n/)
      .map(l => l.replace(/^[ \t]*>[ \t]?/, ''))
      .join('\n')
      .trim()
    if (inner.length > 0) blocks.push({ block: inner, tag: 'blockquote' })
    if (q.index === BLOCKQUOTE_RE.lastIndex) BLOCKQUOTE_RE.lastIndex++
  }

  return blocks
}

/**
 * Remove every RAG data block from a prompt, leaving only the surrounding
 * user-authored text. Used to test whether injection keywords live EXCLUSIVELY
 * inside data blocks (which is the structural-poisoning signal).
 */
function stripRagContext(prompt: string): string {
  // Tag blocks out first, in one pass: a block of one tag may hold another's.
  const parts: string[] = []
  let at = 0
  for (const s of tagSpans(prompt).sort((a, b) => a.start - b.start)) {
    if (s.start >= at) parts.push(prompt.slice(at, s.start), ' ')
    at = Math.max(at, s.end)
  }
  parts.push(prompt.slice(at))
  let stripped = parts.join('')
  stripped = stripped.replace(FENCE_RE, ' ')
  stripped = stripped.replace(BLOCKQUOTE_RE, ' ')
  return stripped
}

// Escalation multiplier applied when injection keywords are confined to data
// blocks. Data should never issue system overrides, so any hit there is far
// more suspicious than the same hit in user-authored text. The product must
// clear the 50-point block threshold even for the weakest single rule (10pt
// soft-signal → 30), so we use 3x.
const RAG_BOUNDARY_MULTIPLIER = 3

// The score at which the user's own text is a direct injection the standard
// heuristic stage blocks, so the boundary check defers to it.
const DIRECT_INJECTION_SCORE = 50

// Rules too weak to escalate a block on their own when the user's text carries
// signals of its own: ordinary markdown and documentation match them.
const WEAK_RULES: ReadonlySet<string> = new Set(['soft-signal', 'delimiter-break'])

const TAG_NAMES: ReadonlySet<string> = new Set(TAG_BLOCKS.map(t => t.tag))

/**
 * Structural RAG-poisoning score.
 *
 * Escalates when prompt-injection keywords are detected EXCLUSIVELY inside an
 * extracted RAG data block: the block scores high under the standard heuristic
 * scorer while the prompt with all data blocks removed scores low. In that case
 * the (passive) data is trying to issue (active) instructions — the hallmark of
 * context poisoning — so the data-block score is amplified by a large
 * multiplier to cross the block threshold.
 *
 * If keywords are ALSO present in the user-authored remainder, this is ordinary
 * direct injection and is left for the standard heuristic stage to handle
 * (score 0 returned here so we do not double-count).
 *
 * Pure and unit-testable: the HeuristicScorer is injected.
 */
export function ragInjectionScore(prompt: string, scorer: HeuristicScorer): HeuristicResult {
  const blocks = extractRagContext(prompt)
  if (!blocks.length) return { score: 0, matches: [] }

  // Highest standard-heuristic score across all isolated data blocks. Rules
  // only: the high-entropy bonus is not an instruction, and a pasted .env file
  // clears it on its own (entropy 5.03 to 5.06 against the 5.0 line), so
  // tripling it blocked ordinary "is my config right?" questions. An encoded
  // instruction is still caught here through its decoded candidate.
  // Tag blocks (<document>, <context>, ...) are retrieved data by their
  // markup. Code fences and blockquotes are ordinary markdown as often as not.
  let maxBlockScore = 0
  let maxTagScore = 0
  const matches = new Set<string>()
  const tagMatches = new Set<string>()
  for (const { block, tag } of blocks) {
    const h = scorer.scoreRules(block, 'document')
    if (h.score > maxBlockScore) maxBlockScore = h.score
    for (const m of h.matches) matches.add(m)
    if (TAG_NAMES.has(tag)) {
      if (h.score > maxTagScore) maxTagScore = h.score
      for (const m of h.matches) tagMatches.add(m)
    }
  }

  if (maxBlockScore <= 0) return { score: 0, matches: [] }

  // Is the user's own text an injection the standard stage blocks? Then it is
  // direct injection, not data-channel poisoning: defer to that stage. Rules
  // only, at the block line (#919).
  const outside = stripRagContext(prompt)
  if (scorer.scoreRules(outside, 'prompt').score >= DIRECT_INJECTION_SCORE) return { score: 0, matches: [] }
  // User text that scores nothing keeps the escalation it always had. User
  // text with only weak signals of its own (a formatting request, the entropy
  // bonus) used to switch the check off for every block (#919); now a tag
  // block is still escalated when it holds a rule stronger than the weak ones.
  // Code fences and blockquotes keep the old deferral: lifted for them, the
  // fence in a repository's CLAUDE.md (a directory listing) and Claude Code's
  // own skill text in a reminder both blocked.
  if (scorer.score(outside, undefined, undefined, 'prompt').score > 0) {
    if (maxTagScore <= 0 || ![...tagMatches].some(m => !WEAK_RULES.has(m))) return { score: 0, matches: [] }
    tagMatches.add('rag-boundary-violation')
    return { score: maxTagScore * RAG_BOUNDARY_MULTIPLIER, matches: Array.from(tagMatches) }
  }

  matches.add('rag-boundary-violation')
  return { score: maxBlockScore * RAG_BOUNDARY_MULTIPLIER, matches: Array.from(matches) }
}
