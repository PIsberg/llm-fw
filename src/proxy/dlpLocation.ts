import type { DlpFinding, DlpLocation, PayloadParser } from '../types.js'

// Where in a request a DLP finding was (#702). The scanner reads the raw body,
// so a finding carries only its type, its text and an offset; an event that
// said only GENERIC_SECRET left no way to tell a leaked key from a false
// positive. The location names the surface and the tool, and the excerpt is
// masked: the secret itself is never recorded.

/** Locations kept per event: enough to read, bounded for a body full of keys. */
const MAX_LOCATIONS = 10

/**
 * A secret as an event may show it: its first and last two characters and its
 * length, or only the length when it is too short to spare four characters.
 */
export function maskSecret(secret: string): string {
  const length = `(${secret.length} chars)`
  return secret.length > 8 ? `${secret.slice(0, 2)}…${secret.slice(-2)} ${length}` : `… ${length}`
}

/**
 * One location per finding, in the order found, at most MAX_LOCATIONS. The
 * surface is the first that holds the match: a tool result (with the tool's
 * name when the request carries its call), the system prompt, a prompt, or
 * else `request` (tool definitions, metadata, a body the parser cannot read).
 */
export function locateDlpFindings(parser: PayloadParser | null, body: string, findings: readonly DlpFinding[]): DlpLocation[] {
  let toolResults: { result: string; toolName?: string | undefined }[] = []
  let system: string[] = []
  let prompts: string[] = []
  if (parser) {
    try {
      toolResults = parser.extractToolResults(body)
      system = parser.extractSystem?.(body) ?? []
      prompts = parser.extractPrompts(body)
    } catch {
      // A body the parser cannot read is located as the request.
    }
  }
  return findings.slice(0, MAX_LOCATIONS).map(f => {
    const masked = maskSecret(f.match)
    const tool = toolResults.find(tr => tr.result.includes(f.match))
    if (tool) return { type: f.type, surface: 'tool_result', ...(tool.toolName ? { toolName: tool.toolName } : {}), masked }
    if (system.some(s => s.includes(f.match))) return { type: f.type, surface: 'system', masked }
    if (prompts.some(p => p.includes(f.match))) return { type: f.type, surface: 'prompt', masked }
    return { type: f.type, surface: 'request', masked }
  })
}

/** Where the first finding was, for an event's one-line preview: `in tool_result (Bash)`. */
export function locationSummary(locations: readonly DlpLocation[]): string {
  const first = locations[0]
  if (!first) return ''
  const tool = first.toolName ? ` (${first.toolName})` : ''
  return ` in ${first.surface}${tool}`
}
