// Envelopes an agent client wraps its own text in, recognised so the
// wrapper is not scanned as if the text had written it.
//
// Codex CLI sends each AGENTS.md it loads as a user message in its own
// envelope: a "# AGENTS.md instructions[ for <dir>]" line, then the file
// between <INSTRUCTIONS> and </INSTRUCTIONS>. The close tag scored
// system-spoof and the pair delimiter-break, 50 together, so every Codex
// session through the proxy had its AGENTS.md withheld (#459, found live).
// Only the outer envelope of a text that is exactly one is dropped: the file
// inside is still scored, a tag planted inside it still matches, and the
// same tags anywhere else still do. String operations, not a regex, so a
// long text that merely starts with the header costs one pass.
const CODEX_AGENTS_HEADER = '# agents.md instructions'
const CODEX_AGENTS_OPEN = '<instructions>'
const CODEX_AGENTS_CLOSE = '</instructions>'
/**
 * The file inside, when the raw text is exactly one envelope; otherwise the
 * text unchanged. Decided on the raw text, before normalization joins lines.
 */
export function unwrapCodexAgentsEnvelope(raw: string): string {
  const trimmed = raw.trim()
  const lower = trimmed.toLowerCase()
  if (!lower.startsWith(CODEX_AGENTS_HEADER) || !lower.endsWith(CODEX_AGENTS_CLOSE)) return raw
  const open = lower.indexOf(CODEX_AGENTS_OPEN)
  if (open === -1) return raw
  // The header is one line, then only blank lines before the open tag.
  const header = trimmed.slice(0, open)
  const firstBreak = header.indexOf('\n')
  if (firstBreak === -1 || header.slice(firstBreak).trim() !== '') return raw
  return trimmed.slice(open + CODEX_AGENTS_OPEN.length, trimmed.length - CODEX_AGENTS_CLOSE.length)
}
