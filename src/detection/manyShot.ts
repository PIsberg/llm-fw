// Many-shot jailbreaking detector.
//
// Many-shot jailbreaking (Anthropic, 2024) floods a single prompt with many
// FABRICATED dialogue turns — invented "Human:/Assistant:" exchanges in which a
// faux assistant complies with escalating harmful requests — exploiting
// in-context learning so the model continues the demonstrated pattern and
// answers a final harmful question. The individual faux turns rarely carry
// classic "ignore previous instructions" keywords, so the heuristic/embedding
// stages miss the attack; its signature is STRUCTURAL: an abnormally long run
// of fabricated role-labeled turns, especially when the faux ASSISTANT answers
// demonstrate compliance with clearly harmful asks.
//
// To stay high-precision (users legitimately paste real chat transcripts to
// summarize), a long faux dialogue ALONE is only a warn — it routes to the
// judge. A block requires the structural signal AND multiple faux assistant
// turns that exhibit harmful compliance, which a benign transcript does not.

export interface ManyShotConfig {
  enabled: boolean
  /** Role-labeled turns required before a text is considered "many-shot". */
  minTurns: number
  /** Faux assistant turns showing harmful compliance required to block. */
  harmfulComplianceThreshold: number
  /** 'block' acts on harmful many-shot; 'audit' only ever warns. */
  mode: 'audit' | 'block'
}

export interface ManyShotResult {
  /** Total role-labeled turns detected. */
  turns: number
  /** Subset labeled as the assistant / model side. */
  assistantTurns: number
  /** Assistant turns whose body demonstrates compliance with a harmful ask. */
  harmfulComplianceTurns: number
  severity: 'none' | 'warn' | 'block'
}

// A turn label at the start of a line, in the transcript formats attackers use:
//   "Human:", "Assistant:", "Q:", "A:", "### Human", "[Assistant]", "<user>".
// Capture the role word so it can be classified as user- or assistant-side.
const TURN_LABEL_RE =
  /^[ \t>#*\-\[]*<?\b(human|user|usuario|assistant|ai|a\.i\.|bot|gpt|chatbot|model|system|q|a|question|answer|prompt|response|reply)\b>?\s*[:\]>.。]/i

const ASSISTANT_ROLES = new Set([
  'assistant', 'ai', 'a.i.', 'bot', 'gpt', 'chatbot', 'model', 'a', 'answer', 'response', 'reply',
])

// Weapons / cyber / illicit-procedure vocabulary. A faux assistant turn that
// contains one of these is demonstrating compliance with a harmful request —
// the conditioning payload of a many-shot attack. Kept deliberately tight
// (concrete nouns, not generic verbs) so legitimate transcripts don't trip it.
const HARMFUL_TERMS = [
  'napalm', 'methamphetamine', 'meth lab', 'crystal meth', 'explosive', 'explosives',
  'bomb', 'pipe bomb', 'detonator', 'nerve agent', 'sarin', 'ricin', 'anthrax',
  'thermite', 'molotov', 'chlorine gas', 'fentanyl', 'untraceable', 'silencer',
  'malware', 'ransomware', 'keylogger', 'rootkit', 'botnet', 'sql injection',
  'buffer overflow', 'reverse shell', 'privilege escalation', 'exfiltrate',
  'lockpick', 'pick a lock', 'pick the lock', 'hotwire', 'counterfeit', 'credit card dump',
]

const harmfulRe = new RegExp(
  '\\b(' + HARMFUL_TERMS.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b',
  'i',
)

/**
 * Detect a many-shot jailbreak pattern in a single text.
 *
 * Parses line-anchored role labels into turns, counts alternations, and flags
 * faux assistant turns whose body demonstrates harmful compliance. Pure and
 * linear in the input length — safe to call on every scanned surface.
 */
export function detectManyShot(text: string, config: ManyShotConfig): ManyShotResult {
  const none: ManyShotResult = { turns: 0, assistantTurns: 0, harmfulComplianceTurns: 0, severity: 'none' }
  if (!text) return none

  const lines = text.split(/\r?\n/)

  // Group lines into turns: a labeled line opens a turn; following unlabeled
  // lines belong to it. Track each turn's role and accumulated body text.
  interface Turn { role: string; body: string }
  const turns: Turn[] = []
  for (const line of lines) {
    const m = TURN_LABEL_RE.exec(line)
    if (m) {
      const role = m[1].toLowerCase()
      const body = line.slice(m[0].length)
      turns.push({ role, body })
    } else if (turns.length > 0) {
      turns[turns.length - 1].body += '\n' + line
    }
  }

  if (turns.length < config.minTurns) {
    return { turns: turns.length, assistantTurns: 0, harmfulComplianceTurns: 0, severity: 'none' }
  }

  // Require genuine back-and-forth: a single repeated label (e.g. a bulleted
  // list that happens to start every line with "A.") is not a dialogue.
  const distinctRoles = new Set(turns.map(t => t.role))
  if (distinctRoles.size < 2) {
    return { turns: turns.length, assistantTurns: 0, harmfulComplianceTurns: 0, severity: 'none' }
  }

  let assistantTurns = 0
  let harmfulComplianceTurns = 0
  for (const t of turns) {
    if (!ASSISTANT_ROLES.has(t.role)) continue
    assistantTurns++
    if (harmfulRe.test(t.body)) harmfulComplianceTurns++
  }

  // Need at least two assistant turns for in-context conditioning to be the
  // intent (one Q/A pair is just a question, not a demonstration pattern).
  if (assistantTurns < 2) {
    return { turns: turns.length, assistantTurns, harmfulComplianceTurns: 0, severity: 'none' }
  }

  let severity: ManyShotResult['severity'] = 'warn'
  if (harmfulComplianceTurns >= config.harmfulComplianceThreshold) severity = 'block'
  if (config.mode === 'audit' && severity === 'block') severity = 'warn'

  return { turns: turns.length, assistantTurns, harmfulComplianceTurns, severity }
}
