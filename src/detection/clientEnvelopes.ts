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
// Claude Code sends a slash command the user typed as three tags, and wraps
// the text of its own side requests (session titles, the security review) in
// <session>. The real classifier scored the command envelope 90.8% injection
// around a prompt it scores 100% safe alone (live, 2026-10-30). Only a text
// that is exactly one envelope is unwrapped, and only the tags go: the
// message, the name and the arguments are all still scored, so an envelope
// cannot carry anything past the classifier.
const CLAUDE_COMMAND = /^<command-message>([^<\n]{1,200})<\/command-message>\s*<command-name>([^<\n]{1,200})<\/command-name>(?:\s*<command-args>([\s\S]*)<\/command-args>)?$/
const SESSION_OPEN = '<session>'
const SESSION_CLOSE = '</session>'

/** What a Claude Code envelope carries (nested ones too); otherwise the text unchanged. */
export function unwrapClaudeCodeEnvelope(raw: string): string {
  let text = raw
  for (let depth = 0; depth < 3; depth++) {
    const trimmed = text.trim()
    if (trimmed.startsWith(SESSION_OPEN) && trimmed.endsWith(SESSION_CLOSE) && trimmed.length >= SESSION_OPEN.length + SESSION_CLOSE.length) {
      text = trimmed.slice(SESSION_OPEN.length, trimmed.length - SESSION_CLOSE.length)
      continue
    }
    const command = CLAUDE_COMMAND.exec(trimmed)
    if (!command) return text
    text = command.slice(1).filter(Boolean).join(' ')
  }
  return text
}

// Fixed strings Claude Code writes as a tool result in place of output. They
// carry nothing a tool or an attacker wrote, and the classifier scored them
// 99.9% injection.
const CLAUDE_NOTICES: ReadonlySet<string> = new Set([
  '(Bash completed with no output)',
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

/** True for a text that is exactly one of Claude Code's own notices. */
export function isClaudeCodeNotice(text: string): boolean {
  return CLAUDE_NOTICES.has(text.trim())
}

// Claude Code adds its own notes to a user turn as <system-reminder> blocks,
// each a text part of its own beside what the user typed. Its own sentences
// are instructions to the model by design, and the real classifier scored
// every one of them 97-100% injection (live, 2026-10-31: the commit
// attribution lines, "the user hasn't heard from you", "only you see that
// command's output", the line above a CLAUDE.md), so with the stage on each
// turn that carried one was withheld and the newest refused. What the blocks
// carry is another matter: a CLAUDE.md is the repository's text, a memory
// file the agent's own, and the same model scores those bodies near 0 on
// their own (this repository's CLAUDE.md 0.00%, a rules file 0.00%, the
// memory index 0.05%), so they stay scored, each body by itself. Dropping
// single sentences instead is not an option: the model is not monotonic on
// short residues (a block scoring 0.96% whole scored 98.8% once its one
// instruction sentence was removed). The heuristic and embedding stages still
// read the whole turn, every sentence included.
const REMINDER_OPEN = '<system-reminder>'
const REMINDER_CLOSE = '</system-reminder>'
// The first line of each block Claude Code writes. A block that opens with
// none of these was written by something else and is scored whole.
const HARNESS_OPENERS: readonly RegExp[] = [
  /^Codebase and user instructions are shown below\./,
  /^As you answer the user's questions, you can use the following context:/,
  /^This is the git status at the start of the conversation\./,
  /^Attribution for git commits and pull requests you create from here on/,
  /^The user hasn't heard from you in a while/,
  /^Only you see that command's output/,
  /^\[SYSTEM NOTIFICATION - NOT USER INPUT\]/,
  /^Note: .{1,512} changed on disk since you last read it\./,
  /^The following (?:deferred )?tools (?:just became|are now) available/,
  /^Tool loaded\.$/,
  /^Background security review of committed or pushed changes/,
]
// Inside a harness block, "Contents of <path> (<what it is>):" opens a file
// the user or a repository wrote, which runs to the next such line.
const isFileHeader = (line: string): boolean => line.startsWith('Contents of ') && line.trimEnd().endsWith('):')

/** The file bodies of a harness block, or the whole block when it is not one. */
function reminderParts(inner: string): string[] {
  const lines = inner.split('\n')
  const first = lines.find(l => l.trim() !== '')?.trim() ?? ''
  if (!HARNESS_OPENERS.some(re => re.test(first))) return inner.trim() ? [inner.trim()] : []
  const parts: string[] = []
  let body: string[] | null = null
  for (const line of lines) {
    if (isFileHeader(line)) {
      if (body) parts.push(body.join('\n'))
      body = []
    } else if (body) {
      body.push(line)
    }
  }
  if (body) parts.push(body.join('\n'))
  return parts.map(p => p.trim()).filter(Boolean)
}

/**
 * The texts of a Claude Code user turn worth scoring on their own: what was
 * typed outside the <system-reminder> blocks, each file a block carries, and
 * each block Claude Code did not write. Whole blocks only, found with indexOf
 * (a text can hold thousands of unclosed openers; a lazy regex rescans to the
 * end from each); an unclosed tag stays in the typed text.
 */
export function unwrapClaudeCodeReminders(text: string): string[] {
  let open = text.indexOf(REMINDER_OPEN)
  if (open < 0) return text.trim() ? [text] : []
  const parts: string[] = []
  let outside = ''
  let last = 0
  while (open >= 0) {
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length)
    if (close < 0) break
    outside += text.slice(last, open)
    parts.push(...reminderParts(text.slice(open + REMINDER_OPEN.length, close)))
    last = close + REMINDER_CLOSE.length
    open = text.indexOf(REMINDER_OPEN, last)
  }
  outside = (outside + text.slice(last)).trim()
  return outside ? [outside, ...parts] : parts
}

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
