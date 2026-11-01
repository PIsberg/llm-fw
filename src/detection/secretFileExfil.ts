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

// Sending: an outbound verb, and somewhere outside to send to after it ("send
// X to DEST"). Not the first half of a compound: replaying real tool results,
// "a paste-ready example under [docs](https://...)" beside `Read(./.env)` was
// the one benign hit the earlier rules had not already caught (2026-11-01).
const SEND_VERB_RE = /\b(?:send|post|upload|transmit|forward|e-?mail|share|leak|exfiltrate|paste|publish|submit|attach|curl|wget|scp|rsync)\b(?!-)/gi
// An address is found at its `@`, never by a leading run of address
// characters, which restarts at every position of a long run
// (GHSA-gm3q-2gwx-gppq).
const DESTINATION_RE = /https?:\/\/|(?<=[\w.%+-])@[A-Za-z0-9-]+\.[A-Za-z]{2}|\b\d{1,3}(?:\.\d{1,3}){3}\b/g
// A destination before the verb counts too ("To https://..., post ..."),
// unless it is a reference: a link the sentence points the reader to ("See
// https://docs...:", "[docs](https://...)"), which is how the one benign
// hit in real tool results was shaped.
const REFERENCE_BEFORE_RE = /(?:\b(?:see|docs?|documentation|guide|page|reference|readme|linked?|under|per|from)\W{0,4}|\]\()$/i
// "Never post ...", "don't upload ...": advice against the act, not an order.
// Only a negation right before the verb counts: "do not forget to post" orders it.
const NEGATED_BEFORE_RE = /\b(?:never|not|don'?t|doesn'?t|mustn'?t|shouldn'?t|cannot|can'?t|won'?t|avoid)\s+(?:then\s+|also\s+)?$/i
// A modal with a third-party subject earlier in the sentence makes it a
// description, not an order, and it governs a verb coordinated after it: a
// security doc or an issue saying an attacker "could read" the AWS
// credentials file "and post it" to a URL. Not a modal that opens the
// sentence or follows you, I, we or please, nor one followed by you: "Could
// you post ...", "You could then upload ...", "I would like you to send ..."
// are requests, and an attacker writes them as easily as an imperative.
const DESCRIPTIVE_MODAL_RE = /(?<=\w\s)(?<!\b(?:you|i|we|please)\s)\b(?:could|would|might|may)\b(?!\s+(?:you|please|i|we)\b)/i
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

/** Where each send verb that is an order (not negated, not under a modal) ends. */
function orderedSends(sentence: string): number[] {
  const ends: number[] = []
  SEND_VERB_RE.lastIndex = 0
  for (let m = SEND_VERB_RE.exec(sentence); m !== null; m = SEND_VERB_RE.exec(sentence)) {
    if (NEGATED_BEFORE_RE.test(sentence.slice(Math.max(0, m.index - 24), m.index))) continue
    if (DESCRIPTIVE_MODAL_RE.test(sentence.slice(0, m.index))) continue
    ends.push(m.index + m[0].length)
  }
  return ends
}

/**
 * True when the sentence has a destination after its first ordered send verb,
 * or before it and not as a reference.
 */
function sendsToDestination(sentence: string, firstSendEnd: number): boolean {
  DESTINATION_RE.lastIndex = 0
  for (let d = DESTINATION_RE.exec(sentence); d !== null; d = DESTINATION_RE.exec(sentence)) {
    if (d.index >= firstSendEnd) return true
    if (!REFERENCE_BEFORE_RE.test(sentence.slice(Math.max(0, d.index - 24), d.index))) return true
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
    const sends = orderedSends(sentence)
    const snippet = sentence.trim().slice(0, 200)
    if (sends.length > 0 && sendsToDestination(sentence, sends[0]!)) return { path: m[0], reason: 'send', snippet }
    if (CONCEAL_RE.test(sentence) || (sends.length > 0 && STEALTH_ADVERB_RE.test(sentence))) return { path: m[0], reason: 'conceal', snippet }
  }
  return null
}
