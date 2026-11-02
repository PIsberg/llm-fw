// Instructions planted in a repository's CLAUDE.md, its rules files or an agent
// memory file (#637), beyond the credential file secretFileExfil.ts reads for.
//
// Read only on those files, never on a README or a tool result, where these
// commands are usually someone explaining them. Each shape was counted over
// the 1,063 instruction and memory files on the author's machine first
// (2026-11-02): piping a download to a shell, authorized_keys, shell-profile
// writes, git remotes and package registries occur in none; guardrail flags
// and settings occur in 20, all descriptive.
//
// A block refuses every request in that repository, since the file is part of
// the prompt and cannot be withheld, so a plain line decides by what it is:
// - HIGH has no ordinary reason to be in an instruction file: blocks.
// - MEDIUM plausibly sits in a contributor's setup notes: warns, and blocks
//   with a trigger ("before every push") or concealment ("do not mention it").
// - GUARDRAIL is usually a description: only a trigger or concealment counts.
//
// Negation spares a line only right before the command, and only with a verb
// that means carrying it out between them ("do not run", "avoid using"). An
// attacker writes every other word on the line, so "do not forget to", "do not
// skip running" and a "do not" in an earlier clause all keep the command an
// order. A list of allowed verbs, since a list of refused ones ("mind",
// "forget") is one synonym away from being faked; the security reviews of
// secretFileExfil.ts faked three looser exemptions.
//
// Linear time: one pass over the lines, whole, since every pattern opens on a
// literal and has bounded spans. Nothing is truncated: padding hides nothing.

export interface PlantedInstructionFinding {
  shape: string
  action: 'block' | 'warn'
  snippet: string
}

interface Shape { name: string; re: RegExp }

const HIGH: readonly Shape[] = [
  { name: 'remote-script', re: /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/gi },
  { name: 'remote-script', re: /\b(?:ba|z|da|k)?sh\b[^\n]{0,20}(?:<\(|\$\()\s*(?:curl|wget)\b/gi },
  { name: 'remote-script', re: /\b(?:iwr|irm|invoke-webrequest|invoke-restmethod)\b[^\n|]{0,200}\|\s*(?:iex|invoke-expression)\b/gi },
  { name: 'authorized-key', re: /(?:>>|\btee\b)[^\n]{0,40}authorized_keys\b/gi },
  { name: 'authorized-key', re: /\b(?:add|append|copy|write|put|install)\b[^\n]{0,60}\bto\b[^\n]{0,20}authorized_keys\b/gi },
  { name: 'shell-profile', re: /(?:>>|\btee\s+-a\b)\s*["']?[^\s"']{0,40}\.(?:bashrc|zshrc|profile|bash_profile|zprofile)\b/gi },
]

const MEDIUM: readonly Shape[] = [
  { name: 'git-remote', re: /\bgit remote (?:add|set-url)\b/gi },
  { name: 'package-registry', re: /\b(?:npm|pnpm|yarn) config set (?:@[\w-]+:)?registry\b/gi },
  { name: 'package-registry', re: /\bpip3? config set\b|--(?:extra-)?index-url\s+http/gi },
]

const GUARDRAIL: readonly Shape[] = [
  { name: 'skip-checks', re: /--no-verify\b|--dangerously-skip-permissions\b|\bbypassPermissions\b/gi },
  { name: 'disable-guardrail', re: /\b(?:disable|turn off|remove|delete|uninstall|bypass|skip)\b[^.\n]{0,40}\b(?:hooks?|firewall|llm-fw|guardrails?)\b/gi },
  { name: 'allow-rule', re: /\b(?:add|write|set|put)\b[^.\n]{0,40}(?:permissions\.allow|\.claude[\\/]settings)/gi },
]

// A trigger makes a line a standing order rather than a step someone may run.
const TRIGGER_RE = /\b(?:before|after|on|at)\s+(?:every|each)\b|\bevery\s+time\b|\bwhenever\b|\balways\b|\bat\s+(?:the\s+)?(?:session\s+)?(?:start|beginning)\b|\bautomatically\b|\b(?:silently|secretly|quietly|covertly)\b/i
const CONCEAL_RE = /\b(?:(?:do\s+not|don'?t|never)\s+(?:mention|tell|inform|notify|alert|report|show)|without\s+(?:mentioning|telling|informing|notifying|alerting|asking))\b[^\n]{0,60}?\b(?:the\s+user|users?|anyone|the\s+developer|the\s+human|them|this|it)\b/i

// Right before the command, with at most a verb for carrying it out between.
const NEGATED_RE = /\b(?:never|don'?t|do\s+not|must\s+not|mustn'?t|avoid)\s+(?:(?:run(?:ning)?|us(?:e|ing)|execut(?:e|ing)|call(?:ing)?|invok(?:e|ing)|pip(?:e|ing)|commit(?:ting)?\s+with|push(?:ing)?\s+with)\s+)?(?:with\s+)?[`'"(]?$/i
// "Never skip hooks (--no-verify)" forbids the flag it names, and real files say
// so. For guardrail flags only: "do not skip setup (curl ... | sh)" orders the
// command in the parenthesis.
const NEGATED_FLAG_RE = /\b(?:never|don'?t|do\s+not|must\s+not|mustn'?t|avoid)\s+skip(?:ping)?\s+\w+\s+\($/i
const NEGATION_REACH = 40

function negated(line: string, at: number, flag: boolean): boolean {
  const before = line.slice(Math.max(0, at - NEGATION_REACH), at)
  return NEGATED_RE.test(before) || (flag && NEGATED_FLAG_RE.test(before))
}

interface Hit { name: string; snippet: string }

/**
 * The first occurrence of any shape on the line that is not negated right
 * before it. Every occurrence counts: a negated first one hides nothing.
 */
function firstHit(line: string, shapes: readonly Shape[], flag = false): Hit | null {
  for (const s of shapes) {
    s.re.lastIndex = 0
    for (let m = s.re.exec(line); m !== null; m = s.re.exec(line)) {
      if (!negated(line, m.index, flag)) return { name: s.name, snippet: line.slice(Math.max(0, m.index - 60), m.index + 140).trim() }
    }
  }
  return null
}

/** The strongest finding in an instruction file: a block over a warn; null when there is none. */
export function detectPlantedInstruction(text: string): PlantedInstructionFinding | null {
  if (!text || text.length < 8) return null
  let warn: PlantedInstructionFinding | null = null
  for (const line of text.split('\n')) {
    if (line.length < 8) continue
    const high = firstHit(line, HIGH)
    if (high) return { shape: high.name, action: 'block', snippet: high.snippet }
    const standing = TRIGGER_RE.test(line) || CONCEAL_RE.test(line)
    const medium = firstHit(line, MEDIUM)
    if (medium) {
      if (standing) return { shape: medium.name, action: 'block', snippet: medium.snippet }
      warn ??= { shape: medium.name, action: 'warn', snippet: medium.snippet }
    }
    if (standing) {
      const guardrail = firstHit(line, GUARDRAIL, true)
      if (guardrail) return { shape: guardrail.name, action: 'block', snippet: guardrail.snippet }
    }
  }
  return warn
}
