import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from '../types.js'
import type { ModuleEvent, TokenPrunerConfig } from '../../types.js'

interface MessagePart {
  type?: string
  text?: string
}

interface MessageItem {
  role?: string
  content?: string | MessagePart[]
}

interface GeminiPart {
  text?: string
}

interface GeminiItem {
  parts?: GeminiPart[]
}

interface LlmPayload {
  messages?: MessageItem[]
  system?: string | MessagePart[]
  contents?: GeminiItem[]
  prompt?: string
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line)

// Minifies multiline JSON objects and arrays that open at the start of a line
// and close on a later line holding only the matching bracket. Returns the
// rewritten lines plus the indices of the minified ones, which the whitespace
// pass must leave alone (their string values may hold meaningful spaces).
//
// Linear on purpose. The first cut used a lazy regex that rescanned to the end
// of the text from every line starting with `{`, which is quadratic: 1.4 s of
// event-loop time on a 160 KB prompt of such lines. Here the next closing line
// is looked up from a table, and the total text handed to JSON.parse is capped
// at a small multiple of the input, so a prompt full of near-JSON costs at
// most a few linear passes.
function minifyEmbeddedJson(lines: string[]): { lines: string[]; json: Set<number> } {
  const n = lines.length
  const nextClose = { '}': new Int32Array(n + 1).fill(-1), ']': new Int32Array(n + 1).fill(-1) }
  for (let i = n - 1; i >= 0; i--) {
    const l = stripCr(lines[i]!)
    nextClose['}'][i] = l === '}' ? i : nextClose['}'][i + 1]!
    nextClose[']'][i] = l === ']' ? i : nextClose[']'][i + 1]!
  }

  let budget = 4 * lines.reduce((sum, l) => sum + l.length + 1, 0)
  const out: string[] = []
  const json = new Set<number>()
  for (let i = 0; i < n; i++) {
    const line = lines[i]!
    const open = line[0]
    if ((open === '{' || open === '[') && budget > 0) {
      const j = nextClose[open === '{' ? '}' : ']'][i + 1]!
      if (j > i) {
        const candidate = lines.slice(i, j + 1).join('\n')
        budget -= candidate.length
        try {
          const parsed: unknown = JSON.parse(candidate)
          if (typeof parsed === 'object' && parsed !== null) {
            json.add(out.length)
            out.push(JSON.stringify(parsed))
            i = j
            continue
          }
        } catch {
          // not valid JSON; fall through and keep the line as prose
        }
      }
    }
    out.push(line)
  }
  return { lines: out, json }
}

// Prose outside code fences. Leading indentation is kept: it carries meaning
// in nested markdown lists and in code pasted without a fence. Only interior
// runs of spaces and tabs collapse, trailing whitespace goes, and a run of
// blank lines shrinks to one.
//
// The first and last elements of the split are partial lines (they continue a
// fence's closing line, or run into the next fence's opening one), so they are
// never counted as blank lines.
function prunePlain(part: string): string {
  const { lines, json } = minifyEmbeddedJson(part.split('\n'))
  const out: string[] = []
  let blank = false
  for (let i = 0; i < lines.length; i++) {
    if (json.has(i)) {
      out.push(lines[i]!)
      blank = false
      continue
    }
    const line = stripCr(lines[i]!)
    const indent = /^[ \t]*/.exec(line)![0]
    const rest = line.slice(indent.length).replace(/[ \t]+/g, ' ').trimEnd()
    if (i === 0 || i === lines.length - 1) {
      out.push(rest === '' ? '' : indent + rest)
      continue
    }
    if (rest === '') {
      if (blank) continue
      blank = true
      out.push('')
      continue
    }
    blank = false
    out.push(indent + rest)
  }
  return out.join('\n')
}

export function pruneText(text: string): string {
  if (!text) return text

  // Split by code fences: ```lang\n...```
  const fenceRegex = /(```[a-zA-Z0-9_-]*\r?\n[\s\S]*?```)/g
  const parts = text.split(fenceRegex)

  const processed = parts.map((part) => {
    if (part.startsWith('```') && part.endsWith('```')) {
      const firstLineEnd = part.indexOf('\n')
      if (firstLineEnd === -1) return part
      const header = part.slice(0, firstLineEnd)
      const code = part.slice(firstLineEnd + 1, -3)

      // Preserve indentation inside code blocks, only trim line-trailing whitespace
      const trimmedLines = code
        .split(/\r?\n/)
        .map(line => line.replace(/[^\S\r\n]+$/, ''))
        .join('\n')
      return `${header}\n${trimmedLines}\`\`\``
    }
    return prunePlain(part)
  })

  return processed.join('').trim()
}

export class TokenPrunerModule implements GatewayModule {
  readonly id = 'token-pruner'
  readonly name = 'Token Pruner / Cost Optimizer'
  readonly description = 'Collapses repeated spaces and blank lines and minifies embedded JSON in prompt text; keeps indentation and fenced code'

  // A reference to the live config object, never a copy: hot reload writes
  // leaf values onto the object it already holds (see setPath in
  // src/config/hotReload.ts), and the dashboard persists config, so both see
  // one source of truth.
  private readonly cfg: TokenPrunerConfig

  private totalInvocations = 0
  private tokensOriginal = 0
  private tokensPruned = 0
  private tokensSaved = 0
  private recentEvents: ModuleEvent[] = []

  constructor(config?: TokenPrunerConfig) {
    this.cfg = config ?? { enabled: false }
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  set enabled(value: boolean) {
    this.cfg.enabled = value
  }

  getStats(): ModuleStats {
    const percentSaved = this.tokensOriginal > 0
      ? (this.tokensSaved / this.tokensOriginal) * 100
      : 0
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.totalInvocations,
      tokensOriginal: this.tokensOriginal,
      tokensPruned: this.tokensPruned,
      tokensSaved: this.tokensSaved,
      percentSaved: Math.round(percentSaved * 10) / 10,
      recentEvents: [...this.recentEvents],
    }
  }

  resetStats(): void {
    this.totalInvocations = 0
    this.tokensOriginal = 0
    this.tokensPruned = 0
    this.tokensSaved = 0
    this.recentEvents = []
  }

  transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
    if (!this.enabled) {
      return { body, modified: false }
    }

    let parsed: LlmPayload
    try {
      parsed = JSON.parse(body) as LlmPayload
    } catch {
      return { body, modified: false }
    }

    if (!parsed || typeof parsed !== 'object') {
      return { body, modified: false }
    }

    let changed = false
    // Savings are counted on the prompt text the pruner examined, not on the
    // request body: re-serialising a pretty-printed JSON envelope shrinks the
    // body by bytes the model never sees as tokens.
    let tokensOriginal = 0
    let tokensPruned = 0
    const prune = (text: string): string => {
      const pruned = pruneText(text)
      tokensOriginal += estimateTokens(text)
      tokensPruned += estimateTokens(pruned)
      if (pruned !== text) changed = true
      return pruned
    }

    // 1. OpenAI / generic messages: [{ role, content }]
    if (Array.isArray(parsed.messages)) {
      for (const m of parsed.messages) {
        if (typeof m?.content === 'string') {
          m.content = prune(m.content)
        } else if (Array.isArray(m?.content)) {
          for (const part of m.content) {
            if (part && part.type === 'text' && typeof part.text === 'string') {
              part.text = prune(part.text)
            }
          }
        }
      }
    }

    // 2. Anthropic system prompt
    if (typeof parsed.system === 'string') {
      parsed.system = prune(parsed.system)
    } else if (Array.isArray(parsed.system)) {
      for (const part of parsed.system) {
        if (part && typeof part.text === 'string') {
          part.text = prune(part.text)
        }
      }
    }

    // 3. Gemini contents: [{ parts: [{ text }] }]
    if (Array.isArray(parsed.contents)) {
      for (const item of parsed.contents) {
        if (Array.isArray(item?.parts)) {
          for (const part of item.parts) {
            if (part && typeof part.text === 'string') {
              part.text = prune(part.text)
            }
          }
        }
      }
    }

    // 4. Legacy single prompt
    if (typeof parsed.prompt === 'string') {
      parsed.prompt = prune(parsed.prompt)
    }

    // Totals cover every request with prompt text, including the ones with
    // nothing to prune, so the overall percentage is over all text examined.
    const tokensSaved = Math.max(0, tokensOriginal - tokensPruned)
    if (tokensOriginal > 0) {
      this.totalInvocations++
      this.tokensOriginal += tokensOriginal
      this.tokensPruned += tokensPruned
      this.tokensSaved += tokensSaved
    }

    if (!changed) {
      return { body, modified: false }
    }

    const newBody = JSON.stringify(parsed)
    const percentSaved = tokensOriginal > 0 ? (tokensSaved / tokensOriginal) * 100 : 0

    const overallPercentSaved = this.tokensOriginal > 0
      ? (this.tokensSaved / this.tokensOriginal) * 100
      : 0

    const event: ModuleEvent = {
      id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      moduleId: this.id,
      moduleName: this.name,
      target: ctx.target,
      path: ctx.path,
      tokensOriginal,
      tokensPruned,
      tokensSaved,
      percentSaved: Math.round(percentSaved * 10) / 10,
      totalTokensSaved: this.tokensSaved,
      overallPercentSaved: Math.round(overallPercentSaved * 10) / 10,
      applied: !ctx.dryRun,
    }

    this.recentEvents.unshift(event)
    if (this.recentEvents.length > 50) this.recentEvents.pop()

    return {
      body: newBody,
      modified: true,
      metadata: {
        tokensOriginal,
        tokensPruned,
        tokensSaved,
        percentSaved,
      },
      events: [event],
    }
  }
}
