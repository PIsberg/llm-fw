// A covert credential-file task planted in an instruction file (#593).
//
// Claude Code hands the agent the repository's CLAUDE.md, its rules files and
// the agent's own memory files as part of the user turn. A cloned repository's
// CLAUDE.md is third-party text, and the classic poisoning is one line among
// ordinary ones: read a credential file, send it somewhere, keep quiet about
// it. No stage caught that line, on any surface: the indirect-instruction rules
// anchor on a verb that opens a clause, and here the verb follows "and".
//
// Routing those files through the existing tool-result rules was measured and
// rejected: over the 535 instruction files and 520 memory files on the
// author's machine (2026-11-01), the indirect-instruction rules fired on 1
// repository file and 19 memory files, and memory poisoning on 1, each of
// which would have refused every request in that repository. This rule is the
// narrow version: a well-known credential file in the same sentence as
// either sending it to an outside destination or hiding the step from the
// user. It fired on none of those 1,055 files.
//
// Linear time: one regex pass for the paths (each alternative opens with a
// literal), then fixed-size work on a sentence of at most 2 * SENTENCE_REACH
// characters around each path, skipping paths inside a sentence already read.

export interface SecretFileExfilFinding {
  /** The credential file the sentence names. */
  path: string
  /** 'send': to an outside destination. 'conceal': and hide it from the user. */
  reason: 'send' | 'conceal'
  snippet: string
}

// Credential files whose contents are a secret on their own. Public keys
// (`.pub`), templates (`.env.example`) and `process.env` are not.
const SECRET_PATH_RE = new RegExp(
  String.raw`(?<![\w$.])(?:~|%USERPROFILE%|\$HOME|\$\{HOME\})?[\\/]?\.` +
  String.raw`(?:aws[\\/]credentials\b|ssh[\\/]id_(?:rsa|dsa|ecdsa|ed25519)(?![.\w])|netrc\b|git-credentials\b|` +
  String.raw`config[\\/]gh[\\/]hosts\.yml\b|docker[\\/]config\.json\b|kube[\\/]config\b|npmrc\b|pypirc\b|env(?![.\w-]))`,
  'gi',
)

// Sending: an outbound verb, and somewhere outside to send to.
const SEND_VERB_RE = /\b(?:send|post|upload|transmit|forward|e-?mail|share|leak|exfiltrate|paste|publish|submit|attach|curl|wget|scp|rsync)\b/gi
// An address is found at its `@`, never by a leading run of address
// characters, which restarts at every position of a long run
// (GHSA-gm3q-2gwx-gppq).
const DESTINATION_RE = /https?:\/\/|(?<=[\w.%+-])@[A-Za-z0-9-]+\.[A-Za-z]{2}|\b\d{1,3}(?:\.\d{1,3}){3}\b/
// "Never post ...", "don't upload ...": advice against the act, not an order.
// Only a negation right before the verb counts: "do not forget to post" orders it.
const NEGATED_BEFORE_RE = /\b(?:never|not|don'?t|doesn'?t|mustn'?t|shouldn'?t|cannot|can'?t|won'?t|avoid)\s+$/i
// Hiding the step: a negated telling verb aimed at the user, or "without
// telling the user". Adverbs alone ("git quietly reads ~/.netrc") describe; they
// count only beside a send verb.
const CONCEAL_RE = /\b(?:(?:do\s+not|don'?t|never)\s+(?:mention|tell|inform|notify|alert|report|show)|without\s+(?:mentioning|telling|informing|notifying|alerting|asking))\b[^.!?\n]{0,60}?\b(?:the\s+user|users?|anyone|the\s+developer|the\s+human|them)\b/i
const STEALTH_ADVERB_RE = /\b(?:silently|secretly|quietly|covertly)\b/i

const SENTENCE_REACH = 300

function sentenceStart(text: string, i: number): number {
  const lo = Math.max(0, i - SENTENCE_REACH)
  for (let j = i - 1; j >= lo; j--) {
    const c = text[j]
    if (c === '\n') return j + 1
    if ((c === '.' || c === '!' || c === '?') && /\s/.test(text[j + 1] ?? '')) return j + 1
  }
  return lo
}

function sentenceEnd(text: string, i: number): number {
  const hi = Math.min(text.length, i + SENTENCE_REACH)
  for (let j = i; j < hi; j++) {
    const c = text[j]
    if (c === '\n') return j
    if ((c === '.' || c === '!' || c === '?') && (j + 1 >= text.length || /\s/.test(text[j + 1] ?? ''))) return j + 1
  }
  return hi
}

function unnegatedSendVerb(sentence: string): boolean {
  SEND_VERB_RE.lastIndex = 0
  for (let m = SEND_VERB_RE.exec(sentence); m !== null; m = SEND_VERB_RE.exec(sentence)) {
    if (!NEGATED_BEFORE_RE.test(sentence.slice(Math.max(0, m.index - 24), m.index))) return true
  }
  return false
}

/** The first sentence that orders a credential file sent out or hidden; null when none does. */
export function detectSecretFileExfil(text: string): SecretFileExfilFinding | null {
  if (!text || text.length < 8) return null
  let readTo = -1
  SECRET_PATH_RE.lastIndex = 0
  for (let m = SECRET_PATH_RE.exec(text); m !== null; m = SECRET_PATH_RE.exec(text)) {
    if (m.index < readTo) continue
    const start = sentenceStart(text, m.index)
    const end = sentenceEnd(text, m.index + m[0].length)
    readTo = end
    const sentence = text.slice(start, end)
    const sends = unnegatedSendVerb(sentence)
    const snippet = sentence.trim().slice(0, 200)
    if (sends && DESTINATION_RE.test(sentence)) return { path: m[0], reason: 'send', snippet }
    if (CONCEAL_RE.test(sentence) || (sends && STEALTH_ADVERB_RE.test(sentence))) return { path: m[0], reason: 'conceal', snippet }
  }
  return null
}
