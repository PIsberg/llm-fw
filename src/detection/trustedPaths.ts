import path from 'node:path'

// Trusted paths (detection.surfaces.tool_result.trustedPaths, issues #391,
// #349, #405). A file the agent read from the developer's own project is
// demoted from block to warn when only a wording stage objects to it: game
// code about rogue AIs, a security tool's docs quoting attacks, a README that
// tells a person what to do. Everything else a tool returns stays untrusted.
//
// Deliberately narrow, because a trusted read is exactly where a planted
// injection would hide:
// - only file-read tools, matched by their full name, never shell output,
//   fetches or search results, whose text may come from anywhere. An MCP
//   tool counts only on a server known to read local files: a `read_file`
//   on any other server may be serving fetched content;
// - every path argument the call carries, not just the first one found,
//   since which one the tool honours is the tool's business;
// - only absolute paths, since a relative one is relative to a working
//   directory the proxy cannot see;
// - never third-party code vendored inside a trusted root.

/** Full tool names that read one local file. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'Read', // Claude Code
  'read_file', // Gemini CLI, Cline
  'read_text_file',
  'mcp__lean-ctx__ctx_read',
  'mcp__filesystem__read_file', // the reference MCP filesystem server
  'mcp__filesystem__read_text_file',
])

const PATH_KEYS = ['file_path', 'absolute_path', 'path', 'filePath'] as const

/**
 * Path segments below a trusted root that hold somebody else's code or
 * fetched content, compared lower-cased with trailing dots and spaces
 * dropped: case-insensitive file systems read `Node_Modules` as
 * `node_modules`, and Windows reads `node_modules.` as one too.
 */
const THIRD_PARTY_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', 'third_party', 'site-packages', '.venv', 'venv', '.git',
])
const dirName = (seg: string) => seg.replace(/[. ]+$/, '').toLowerCase()

const DRIVE_RE = /^[a-z]:\//i

/** Forward slashes, `..` resolved; lower-cased when it is a Windows drive path. Null if not absolute. */
function normalise(p: string): string | null {
  const slashed = p.replace(/\\/g, '/')
  const drive = DRIVE_RE.test(slashed)
  if (!drive && !slashed.startsWith('/')) return null
  const norm = path.posix.normalize(slashed).replace(/\/+$/, '')
  return drive ? norm.toLowerCase() : norm
}

function readArgs(input: unknown): Record<string, unknown> | null {
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { return null }
  }
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : null
}

/**
 * The path a tool call read, when the call is a file read under one of
 * `roots` and outside any third-party directory there; otherwise null.
 * `input` is the call's arguments, as an object or a JSON string.
 */
export function trustedReadPath(toolName: string | undefined, input: unknown, roots: readonly string[]): string | null {
  if (!toolName || roots.length === 0 || !READ_TOOLS.has(toolName)) return null
  const args = readArgs(input)
  if (!args) return null
  const paths = PATH_KEYS.filter(k => k in args).map(k => args[k])
  if (paths.length === 0) return null
  for (const p of paths) {
    if (typeof p !== 'string' || !underTrustedRoot(p, roots)) return null
  }
  return paths[0] as string
}

function underTrustedRoot(raw: string, roots: readonly string[]): boolean {
  const file = normalise(raw)
  if (!file) return false
  for (const r of roots) {
    const root = normalise(r)
    if (!root || !file.startsWith(root + '/')) continue
    const below = file.slice(root.length + 1).split('/')
    if (below.slice(0, -1).some(seg => THIRD_PARTY_DIRS.has(dirName(seg)))) continue
    return true
  }
  return false
}
