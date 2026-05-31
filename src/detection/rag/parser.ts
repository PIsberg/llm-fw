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

  for (const { tag, re } of TAG_BLOCKS) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(prompt)) !== null) {
      const inner = (m[1] ?? '').trim()
      if (inner.length > 0) blocks.push({ block: inner, tag })
      // Guard against zero-width matches looping forever.
      if (m.index === re.lastIndex) re.lastIndex++
    }
  }

  FENCE_RE.lastIndex = 0
  let f: RegExpExecArray | null
  while ((f = FENCE_RE.exec(prompt)) !== null) {
    const inner = (f[2] ?? '').trim()
    if (inner.length > 0) blocks.push({ block: inner, tag: 'code-fence' })
    if (f.index === FENCE_RE.lastIndex) FENCE_RE.lastIndex++
  }

  BLOCKQUOTE_RE.lastIndex = 0
  let q: RegExpExecArray | null
  while ((q = BLOCKQUOTE_RE.exec(prompt)) !== null) {
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
  let stripped = prompt
  for (const { re } of TAG_BLOCKS) {
    stripped = stripped.replace(re, ' ')
  }
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

  // Highest standard-heuristic score across all isolated data blocks.
  let maxBlockScore = 0
  const matches = new Set<string>()
  for (const { block } of blocks) {
    const h = scorer.score(block)
    if (h.score > maxBlockScore) maxBlockScore = h.score
    for (const m of h.matches) matches.add(m)
  }

  if (maxBlockScore <= 0) return { score: 0, matches: [] }

  // Do the same keywords appear OUTSIDE the data blocks? If so it is direct
  // injection, not data-channel poisoning — defer to the standard stage.
  const outside = stripRagContext(prompt)
  const outsideScore = scorer.score(outside).score
  if (outsideScore > 0) return { score: 0, matches: [] }

  matches.add('rag-boundary-violation')
  return { score: maxBlockScore * RAG_BOUNDARY_MULTIPLIER, matches: Array.from(matches) }
}
