import path from 'node:path'

// Trusted paths (detection.surfaces.tool_result.trustedPaths, issues #391,
// #349, #405, #437). A file the agent read from the developer's own project is
// demoted from block to warn when only a wording stage objects to it: game
// code about rogue AIs, a security tool's docs quoting attacks, a README that
// tells a person what to do. Everything else a tool returns stays untrusted.
//
// Deliberately narrow, because a trusted read is exactly where a planted
// injection would hide:
// - file-read tools, matched by their full name, and shell tools whose command
//   is one plain read of one file (`cat`, `head`, `tail`, `sed -n N,Mp`,
//   `Get-Content`) with nothing a shell could expand or chain: no pipe,
//   redirection, substitution, separator, glob or variable. Fetches, search
//   results and every other command keep their output untrusted, since it may
//   come from anywhere. An MCP tool counts only on a server known to read
//   local files: a `read_file` on any other server may be serving fetched
//   content;
// - every path argument the call carries, not just the first one found,
//   since which one the tool honours is the tool's business;
// - only absolute paths, or a relative one when the call itself names the
//   working directory it is relative to (Codex sends `workdir`); otherwise the
//   proxy cannot know what the path means;
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

/**
 * Tool names that run a shell command and return its output. `Bash` is
 * Claude Code's, which carries no working directory; `shell`, `shell_command`
 * and `exec_command` are Codex CLI's, which carry `workdir`; `local_shell_call`
 * is the Responses API built-in, whose `action` the parser flattens to the
 * same shape. lean-ctx's `ctx_shell` is not here: it rewrites the output.
 */
const SHELL_TOOLS: ReadonlySet<string> = new Set(['Bash', 'shell', 'shell_command', 'exec_command', 'local_shell_call'])

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

/**
 * Forward slashes, `..` resolved; lower-cased when it is a Windows drive path.
 * Null if not absolute, or if it is a Windows spelling that names a different
 * directory than it reads as: an 8.3 short name (`NODE_M~1` is node_modules),
 * an alternate data stream (`node_modules::$INDEX_ALLOCATION`), or a device or
 * UNC prefix (`\\?\`, `\\.\`). Resolving them would need the client's file
 * system, which a gateway on another host does not have, so they fail closed.
 */
function normalise(p: string): string | null {
  const slashed = p.replace(/\\/g, '/')
  const drive = DRIVE_RE.test(slashed)
  if (!drive && (!slashed.startsWith('/') || slashed.startsWith('//'))) return null
  if (drive && (slashed.slice(2).includes(':') || /~\d/.test(slashed))) return null
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
  const args = readArgs(input)
  if (!args) return null
  if (SHELL_TOOLS.has(toolName)) {
    const file = shellReadPath(args.command, typeof args.workdir === 'string' ? args.workdir : undefined)
    return file && underTrustedRoot(file, roots) ? file : null
  }
  if (!READ_TOOLS.has(toolName)) return null
  const paths = PATH_KEYS.filter(k => k in args).map(k => args[k])
  if (paths.length === 0) return null
  for (const p of paths) {
    if (typeof p !== 'string' || !underTrustedRoot(p, roots)) return null
  }
  return paths[0] as string
}

// A Git Bash path such as /c/dev/x is not read as C:\dev\x (#439): Claude
// Code translates it, but Node's own fs on Windows resolves it to C:\c\dev\x,
// so what it names depends on the client. It stays the POSIX path it reads
// as, which no drive root matches.
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

// ── shell reads (#437) ──────────────────────────────────────────────────────

/**
 * Anything that lets a shell run a second command, expand a word, or send the
 * output somewhere else. One of these anywhere in the script and it is not a
 * plain read: `|`, `;`, `&`, `<`, `>`, `$`, backticks, parentheses and braces
 * (substitution, grouping, PowerShell expressions), `*`, `?`, `[` (globs),
 * `~` (a home directory the proxy cannot resolve), `#` (a comment can hide
 * what follows on a wrapped line), `@` (PowerShell splatting), `^` (cmd's
 * escape), `!` (history or delayed expansion), a newline. A comma, which
 * makes a PowerShell list, is allowed only inside a sed line range.
 */
const SHELL_META = /[|;&<>$`(){}*?[\]~#@^!\n\r]/

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell', 'cmd'])
const SHELL_SCRIPT_FLAGS: ReadonlySet<string> = new Set(['-c', '-lc', '-command', '/c'])

/** Options a read command may carry: `true` takes a number, `'path'` names the file, `'script'` a sed range, `'encoding'` a name, `false` stands alone. */
type OptionKind = true | false | 'path' | 'encoding' | 'script'
const OPTIONS: Readonly<Record<string, Readonly<Record<string, OptionKind>>>> = {
  cat: { '-n': false, '-b': false, '-s': false, '-a': false, '-e': false, '-t': false, '-v': false },
  head: { '-n': true, '-c': true, '-q': false },
  tail: { '-n': true, '-c': true, '-q': false },
  sed: { '-n': false, '-e': 'script', '--quiet': false, '--silent': false },
  'get-content': {
    '-totalcount': true, '-tail': true, '-head': true, '-first': true, '-last': true, '-readcount': true,
    '-raw': false, '-encoding': 'encoding', '-path': 'path', '-literalpath': 'path',
  },
  type: {},
}
const ALIASES: Readonly<Record<string, string>> = { gc: 'get-content', 'get-content': 'get-content', type: 'type', cat: 'cat', head: 'head', tail: 'tail', sed: 'sed' }

/** `12p`, `12,40p`: print a line range, nothing else. */
const SED_RANGE = /^\d+(,\d+)?p$/
const COUNT = /^\d+$/
const ENCODING = /^[a-z0-9-]+$/i

/**
 * Split a script on whitespace, keeping a single- or double-quoted word as
 * one token without its quotes. Null on an unterminated quote. Expansions are
 * already excluded by SHELL_META, so quoting only has to carry spaces.
 */
function tokenise(script: string): string[] | null {
  const tokens: string[] = []
  const re = /\s*(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?=\s|$)/y
  let i = 0
  while (i < script.length) {
    if (/\s/.test(script[i]!)) { i++; continue }
    re.lastIndex = i
    const m = re.exec(script)
    if (!m) return null
    tokens.push(m[1] ?? m[2] ?? m[3] ?? '')
    i = re.lastIndex
  }
  return tokens
}

/**
 * The one file a shell command reads, resolved against `workdir` when the
 * command names it relatively; null for anything that is not exactly one
 * plain read command with one path and only its line-selecting options.
 * `command` is a string, or the argv array Codex and `local_shell_call` send,
 * either `[shell, -c|-lc, script]` or the read command's own argv.
 */
function shellReadPath(command: unknown, workdir: string | undefined): string | null {
  let tokens: string[] | null
  if (typeof command === 'string') {
    if (SHELL_META.test(command)) return null
    tokens = tokenise(command)
  } else if (Array.isArray(command) && command.length > 0 && command.every((a): a is string => typeof a === 'string')) {
    const argv: string[] = command
    const exe = path.posix.basename(argv[0]!.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase()
    if (SHELLS.has(exe)) {
      if (argv.length !== 3 || !SHELL_SCRIPT_FLAGS.has(argv[1]!.toLowerCase()) || SHELL_META.test(argv[2]!)) return null
      tokens = tokenise(argv[2]!)
    } else {
      if (argv.some(a => SHELL_META.test(a))) return null
      tokens = argv
    }
  } else {
    return null
  }
  if (!tokens || tokens.length < 2) return null

  const verb = ALIASES[tokens[0]!.toLowerCase()]
  if (!verb) return null
  const options = OPTIONS[verb]!
  let file: string | null = null
  let sedScript: string | null = null
  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!
    if (verb === 'sed' && SED_RANGE.test(tok) && sedScript === null) { sedScript = tok; continue }
    if (tok.includes(',')) return null
    if (tok.startsWith('-')) {
      // `tail -20`, `head -5`
      if ((verb === 'head' || verb === 'tail') && COUNT.test(tok.slice(1))) continue
      const kind = options[tok.toLowerCase()]
      if (kind === undefined) return null
      if (kind === false) continue
      const value = tokens[++i]
      if (value === undefined) return null
      if (kind === true && !COUNT.test(value)) return null
      if (kind === 'encoding' && !ENCODING.test(value)) return null
      if (kind === 'script') { if (verb !== 'sed' || !SED_RANGE.test(value) || sedScript !== null) return null; sedScript = value; continue }
      if (kind === 'path') { if (file !== null) return null; file = value; continue }
      continue
    }
    if (file !== null) return null
    file = tok
  }
  if (file === null || file.length === 0) return null
  if (verb === 'sed' && sedScript === null) return null

  const slashed = file.replace(/\\/g, '/')
  if (normalise(slashed)) return slashed
  if (slashed.startsWith('/') || DRIVE_RE.test(slashed)) return null // absolute but unresolvable: fail closed
  if (!workdir) return null
  const base = normalise(workdir)
  if (!base) return null
  const joined = path.posix.join(base, slashed)
  return normalise(joined) ? joined : null
}
