import path from 'node:path'

// Trusted paths (detection.surfaces.tool_result.trustedPaths, issues #391,
// #349, #405). A file the agent read from the developer's own project is
// demoted from block to warn when only a wording stage objects to it: game
// code about rogue AIs, a security tool's docs quoting attacks, a README that
// tells a person what to do. Everything else a tool returns stays untrusted.
//
// Deliberately narrow, because a trusted read is exactly where a planted
// injection would hide:
// - only file-read tools, matched by name, never shell output, fetches or
//   search results, whose text may come from anywhere;
// - only absolute paths, since a relative one is relative to a working
//   directory the proxy cannot see;
// - never third-party code vendored inside a trusted root.

/** Tool names (after any `mcp__<server>__` prefix), lower-cased, that read one file. */
const READ_TOOLS: ReadonlySet<string> = new Set([
  'read', // Claude Code
  'read_file', // Gemini CLI, Cline, many MCP servers
  'read_text_file', // MCP filesystem server
  'ctx_read', // lean-ctx
])

const PATH_KEYS = ['file_path', 'absolute_path', 'path', 'filePath'] as const

/** Path segments below a trusted root that hold somebody else's code. */
const THIRD_PARTY_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'vendor', 'third_party', 'site-packages', '.venv', 'venv',
])

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
  if (!toolName || roots.length === 0) return null
  if (!READ_TOOLS.has(toolName.replace(/^mcp__.*__/, '').toLowerCase())) return null
  const args = readArgs(input)
  if (!args) return null
  const raw = PATH_KEYS.map(k => args[k]).find((v): v is string => typeof v === 'string' && v.length > 0)
  if (!raw) return null
  const file = normalise(raw)
  if (!file) return null
  for (const r of roots) {
    const root = normalise(r)
    if (!root || !file.startsWith(root + '/')) continue
    const below = file.slice(root.length + 1).split('/')
    if (below.slice(0, -1).some(seg => THIRD_PARTY_DIRS.has(seg))) continue
    return raw
  }
  return null
}
