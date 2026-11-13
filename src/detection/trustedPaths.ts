import path from 'node:path'

// Trusted paths (detection.surfaces.tool_result.trustedPaths, issues #391,
// #349, #405, #437, #776). A file the agent read from the developer's own
// project is demoted from block to warn when only a wording stage objects to
// it: game code about rogue AIs, a security tool's docs quoting attacks, a
// README that tells a person what to do. Everything else a tool returns stays
// untrusted.
//
// Deliberately narrow, because a trusted read is exactly where a planted
// injection would hide:
// - file-read tools, matched by their full name, and shell tools whose command
//   can only print files: under a POSIX shell, reads (`cat`, `head`, `tail`,
//   `sed -n N,Mp`, `grep` without recursion) piped through filters that cut
//   the output down (`cut`, `head`, `tail`, `grep`, `wc`), joined by `&&` or
//   `;`, with `echo` of literal words and `cd`; under any other shell, one
//   plain read of one file (`Get-Content`, `type`). Nothing a shell could
//   expand or redirect: no substitution, variable, glob other than in the
//   last part of a file name after a literal folder, or redirection other
//   than of error messages. Fetches, search results and every other command
//   keep their output untrusted, since it may come from anywhere. An MCP tool
//   counts only on a server known to read local files: a `read_file` on any
//   other server may be serving fetched content;
// - every path argument the call carries, not just the first one found,
//   since which one the tool honours is the tool's business;
// - only absolute paths, or a relative one when the call itself names the
//   working directory it is relative to (Codex sends `workdir`, a command
//   line's own `cd` counts); otherwise the proxy cannot know what the path
//   means;
// - never third-party code vendored inside a trusted root.

/**
 * Full tool names that search local files under a directory and return what
 * they found: Claude Code's Grep (ripgrep, which skips what .gitignore lists,
 * node_modules included) and Glob (file names only). Their `path` may be the
 * root itself. Without a `path` they search the client's working directory,
 * which the call does not name, so they stay untrusted. A search of a whole
 * root can return a line from any file ripgrep reads under it, so this trusts
 * the repository as a Read of each of its files would.
 */
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob'])

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
const dirName = (seg: string) => seg.replace(/(?<![. ])[. ]+$/, '').toLowerCase()

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
  const norm = path.posix.normalize(slashed).replace(/(?<!\/)\/+$/, '')
  return drive ? norm.toLowerCase() : norm
}

/**
 * Why `root` cannot be a trusted root, or null when it can. Rejects what the
 * matcher would never match (a relative path, a home directory, a UNC or
 * device prefix, an 8.3 short name, a data stream), a whole drive or file
 * system, and a root inside a third-party folder, under which nothing is
 * trusted anyway. The dashboard checks a root with this before it applies it.
 */
export function trustedRootProblem(root: string): string | null {
  const norm = normalise(root)
  if (norm === null) return 'must be an absolute path, without ~, a UNC or \\\\?\\ prefix, a short name such as PROGRA~1, or a data stream'
  // normalise drops a trailing slash, so `/` comes back empty and `C:\` as `c:`.
  if (norm === '' || /^[a-z]:$/.test(norm)) return 'is a whole drive or file system; list your project folders instead'
  if (norm.split('/').some(seg => THIRD_PARTY_DIRS.has(dirName(seg)))) return 'is inside a folder of third-party code, where nothing is trusted'
  return null
}

/** `o[k]` when `k` is `o`'s own key, so a word such as `constructor` never finds Object.prototype. */
const own = <T>(o: Readonly<Record<string, T>> | undefined, k: string): T | undefined =>
  o && Object.hasOwn(o, k) ? o[k] : undefined

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
    // Claude Code's Bash runs in a directory the call does not name and is a
    // POSIX shell on every platform, so a `workdir` field on it is not honoured
    // and only an absolute path, or one below a `cd` the command makes, counts.
    const bash = toolName === 'Bash'
    return shellReadPath(args.command, !bash && typeof args.workdir === 'string' ? args.workdir : undefined, bash, roots)
  }
  const search = SEARCH_TOOLS.has(toolName)
  if (!search && !READ_TOOLS.has(toolName)) return null
  const paths = PATH_KEYS.filter(k => k in args).map(k => args[k])
  if (paths.length === 0) return null
  for (const p of paths) {
    if (typeof p !== 'string' || !underTrustedRoot(p, roots, search)) return null
  }
  return paths[0] as string
}

// A Git Bash path such as /c/dev/x is not read as C:\dev\x here (#439): Claude
// Code translates it, but Node's own fs on Windows resolves it to C:\c\dev\x,
// so what it names depends on the client. It stays the POSIX path it reads
// as, which no drive root matches. A command line run by Claude Code's Bash
// is the exception, read in `msysDrive` below: there the shell is Git Bash.
function underTrustedRoot(raw: string, roots: readonly string[], rootItself = false): boolean {
  const file = normalise(raw)
  if (!file) return false
  for (const r of roots) {
    const root = normalise(r)
    if (!root) continue
    if (rootItself && file === root) return true
    if (!file.startsWith(root + '/')) continue
    // A search's path is a directory, so its last segment is one too.
    const below = file.slice(root.length + 1).split('/')
    if (rootItself && THIRD_PARTY_DIRS.has(dirName(below.at(-1) ?? ''))) continue
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
 * escape), `!` (history or delayed expansion), `%` (cmd's variable
 * expansion), a newline. A comma, which makes a PowerShell list, is allowed
 * only inside a sed line range. A backslash is a path separator under
 * PowerShell and an escape under a POSIX shell, where `.\.` is `..`; unless a
 * pwsh wrapper says which shell ran, the path has to stay under the root
 * read both ways.
 */
const SHELL_META = /[|;&<>$`(){}*?[\]~#@^!%\n\r]/

const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'pwsh', 'powershell'])
/** Wrappers that read a backslash as a path separator. `cmd` is not a wrapper here: its quoting and expansion rules are its own. */
const WINDOWS_SHELLS: ReadonlySet<string> = new Set(['pwsh', 'powershell'])
const SHELL_SCRIPT_FLAGS: ReadonlySet<string> = new Set(['-c', '-lc', '-command'])

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
 * The one file a shell command reads under one of `roots`, resolved against
 * `workdir` when the command names it relatively; null for anything that is
 * not exactly one plain read command with one path and only its
 * line-selecting options, or whose file is not under a root. `command` is a
 * string, or the argv array Codex and `local_shell_call` send, either
 * `[shell, -c|-lc, script]` or the read command's own argv. `posix` says the
 * command runs in a POSIX shell whatever its paths look like.
 */
function shellReadPath(command: unknown, workdir: string | undefined, posix: boolean, roots: readonly string[]): string | null {
  let tokens: string[] | null
  let backslash: boolean
  let powershell = false
  if (typeof command === 'string') {
    // Only Claude Code's Bash sends a string it is sure a POSIX shell runs:
    // Git Bash on Windows, so its /c/... paths name drives.
    if (posix) return posixReadPath(command, workdir, roots, true)
    if (SHELL_META.test(command)) return null
    backslash = command.includes('\\')
    tokens = tokenise(command)
  } else if (Array.isArray(command) && command.length > 0 && command.every((a): a is string => typeof a === 'string')) {
    const argv: string[] = command
    const exe = path.posix.basename(argv[0]!.replace(/\\/g, '/')).replace(/\.exe$/i, '').toLowerCase()
    if (SHELLS.has(exe)) {
      if (argv.length !== 3 || !SHELL_SCRIPT_FLAGS.has(argv[1]!.toLowerCase())) return null
      if (!WINDOWS_SHELLS.has(exe)) return posixReadPath(argv[2]!, workdir, roots, false)
      if (SHELL_META.test(argv[2]!)) return null
      powershell = true
      backslash = argv[2]!.includes('\\')
      tokens = tokenise(argv[2]!)
    } else {
      if (argv.some(a => SHELL_META.test(a))) return null
      backslash = argv.some(a => a.includes('\\'))
      tokens = argv
    }
  } else {
    return null
  }
  if (!tokens || tokens.length < 2) return null

  // Own keys only: `constructor` or `__proto__` would otherwise find Object.prototype and throw.
  const verb = own(ALIASES, tokens[0]!.toLowerCase())
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
      if (kind === 'script') {
        if (verb !== 'sed' || !SED_RANGE.test(value) || sedScript !== null) return null
        sedScript = value
        continue
      }
      if (kind === 'path') {
        if (file !== null) return null
        file = value
        continue
      }
      continue
    }
    if (file !== null) return null
    // sed takes its script from the first operand, so a path there is a script
    // and whatever follows is the file: the range has to come first.
    if (verb === 'sed' && sedScript === null) return null
    file = tok
  }
  if (file === null || file.length === 0) return null
  if (verb === 'sed' && sedScript === null) return null

  if (backslash && posix) return null
  const resolved = resolveRead(file.replace(/\\/g, '/'), workdir)
  if (!resolved || !underTrustedRoot(resolved, roots)) return null
  // Without a wrapper naming the shell, a string with a backslash may have
  // run under bash as well as PowerShell (Codex lets the user pick), and bash
  // drops an unquoted backslash: `.\.` is `..`. The file has to be under the
  // root read that way too, or the command could climb out while reading as
  // if it stayed under. The two readings cover what any shell does with the
  // token: an unquoted `\\` or a quoted backslash survives as a literal one,
  // which Windows then reads as a separator, giving the first reading again,
  // and which Linux reads as a character in a name under the same directory,
  // which climbs no further than the first reading either.
  if (backslash && !powershell) {
    const asPosix = resolveRead(file.replace(/\\/g, ''), workdir)
    if (!asPosix || !underTrustedRoot(asPosix, roots)) return null
  }
  return resolved
}

/** `file` (forward slashes) made absolute: as is, or joined to `workdir` when relative; null when neither resolves. */
function resolveRead(file: string, workdir: string | undefined): string | null {
  if (normalise(file)) return file
  if (file.startsWith('/') || DRIVE_RE.test(file)) return null // absolute but unresolvable: fail closed
  if (!workdir) return null
  const base = normalise(workdir)
  if (!base) return null
  const joined = path.posix.join(base, file)
  return normalise(joined) ? joined : null
}

// ── POSIX command lines (#776) ──────────────────────────────────────────────
//
// An agent reading its own repository rarely sends one plain `cat`. Claude
// Code writes `cd /c/dev/proj && sed -n 40,80p src/a.ts | cut -c1-160; grep
// -n key src/b.ts`, and every such read of a trusted root was withheld. A
// command line a POSIX shell runs is trusted when nothing in it can make the
// output come from anywhere but files under a root: a list of pipelines,
// joined by `&&` or `;`, where each pipeline starts with a read of files (or
// an `echo` of literal words) and continues through filters that only cut
// the stream down. Every file any of them names must be under a root, and a
// `cd` only moves where relative names are looked up.

/**
 * Unquoted characters a POSIX shell expands, redirects, globs or reads as
 * syntax. `|`, `&&` and `;` are taken as operators, and `*` and `?` mark a
 * glob (see `posixPath`); a lone `&`, `||` and these make the line untrusted.
 * `#` starts a comment, `!` history, `~` a home directory, `%` a job, `@` and
 * `^` an extended glob or an old pipe, `[` a bracket glob. A backslash is an
 * escape in a POSIX shell, so it is not allowed unquoted.
 */
const POSIX_SPECIAL = /[<>$`(){}[\]~#@^!%\\]/

/**
 * A word with its quotes removed; `escaped` when it holds a literal
 * backslash, which a path must not; `glob` when an unquoted `*` or `?` makes
 * the shell expand it into file names.
 */
interface PosixWord { readonly text: string; readonly escaped: boolean; readonly glob: boolean }
type PosixToken = { readonly op: '|' | '&&' | ';' } | PosixWord

/**
 * Redirections that only move error messages, which a read prints about the
 * names the command line already shows. Taken as whole words only.
 */
const STDERR_ONLY = ['2>&1', '2>/dev/null'] as const

/**
 * The text of the double-quoted part that starts at `start` (just after its
 * `"`), as bash reads it, and the index of its closing quote; null when the
 * shell would expand something in it, or it holds a line break or is left
 * open. `escaped` when the text keeps a literal backslash.
 */
function doubleQuoted(script: string, start: number): { part: string; escaped: boolean; close: number } | null {
  let part = ''
  let escaped = false
  let k = start
  while (k < script.length && script[k] !== '"') {
    const d = script[k]!
    if (d === '$' || d === '`' || d === '!' || d === '\n') return null
    const next = script[k + 1]
    if (d === '\\' && next !== undefined && '$`"\\'.includes(next)) {
      part += next
      if (next === '\\') escaped = true
      k += 2
      continue
    }
    if (d === '\\') escaped = true
    part += d
    k++
  }
  return k < script.length ? { part, escaped, close: k } : null
}

/**
 * Split a POSIX command line into words and the three operators, an unquoted
 * line break counting as `;`. Single quotes keep everything; double quotes
 * keep everything but an escape bash honours there (`\$`, `` \` ``, `\"`,
 * `\\`), and make the line untrusted at a `$`, a backtick or `!`, which a
 * shell would expand. Null for anything else a shell would act on, a quote
 * left open, a carriage return, or a line break inside quotes.
 */
function lexPosix(script: string): PosixToken[] | null {
  if (script.includes('\r')) return null
  const out: PosixToken[] = []
  let text: string | null = null
  let escaped = false
  let glob = false
  const end = () => {
    if (text !== null) out.push({ text, escaped, glob })
    text = null
    escaped = false
    glob = false
  }
  let i = 0
  while (i < script.length) {
    const c = script[i]!
    if (c === ' ' || c === '\t') { end(); i++; continue }
    if (c === '\n') { end(); out.push({ op: ';' }); i++; continue }
    if (c === "'") {
      const close = script.indexOf("'", i + 1)
      if (close < 0) return null
      const part = script.slice(i + 1, close)
      if (part.includes('\n')) return null
      if (part.includes('\\')) escaped = true
      text = (text ?? '') + part
      i = close + 1
      continue
    }
    if (c === '"') {
      const quoted = doubleQuoted(script, i + 1)
      if (!quoted) return null
      if (quoted.escaped) escaped = true
      text = (text ?? '') + quoted.part
      i = quoted.close + 1
      continue
    }
    const redirection = text === null ? STDERR_ONLY.find(r => script.startsWith(r, i) && /^[\s|;&]?$/.test(script[i + r.length] ?? '')) : undefined
    if (redirection) { i += redirection.length; continue }
    if (c === '|') {
      if (script[i + 1] === '|') return null
      end(); out.push({ op: '|' }); i++; continue
    }
    if (c === '&') {
      if (script[i + 1] !== '&') return null
      end(); out.push({ op: '&&' }); i += 2; continue
    }
    if (c === ';') { end(); out.push({ op: ';' }); i++; continue }
    if (POSIX_SPECIAL.test(c)) return null
    if (c === '*' || c === '?') glob = true
    text = (text ?? '') + c
    i++
  }
  end()
  return out
}

/** How a command takes its arguments. Anything not listed makes the line untrusted. */
interface VerbSpec {
  /** Short flags that stand alone, as one string: `nE` for `-n` and `-E`. */
  readonly flags: string
  /** Short flags that take a value, attached (`-c1-80`) or as the next word, and the value's shape. */
  readonly values?: Readonly<Record<string, RegExp>>
  /** Long options: `true` stands alone, a pattern takes `=value`. */
  readonly long?: Readonly<Record<string, true | RegExp>>
  /** `head -20`, `tail -5`. */
  readonly count?: boolean
  /** The first operand is not a file: grep's pattern, sed's script; unless `-e` gave it. */
  readonly lead?: 'pattern' | 'script'
}

const ANY = /^[\s\S]*$/
const SIGNED_COUNT = /^\+?\d+$/
/** A cut list: `5`, `1-80`, `3-`, `-4`, comma-separated. */
const CUT_LIST = /^(?:\d+(?:-\d*)?|-\d+)(?:,(?:\d+(?:-\d*)?|-\d+))*$/
const ONE_CHAR = /^[\s\S]$/u
const COLOR = /^(?:never|always|auto)$/

/**
 * The commands a trusted line may run. Each reads only the files it names,
 * or its input, and writes only to its output: no option that recurses into
 * a directory (`grep -r`, which also walks node_modules), reads patterns from
 * a file (`grep -f`), edits in place (`sed -i`), runs anything (`sed`'s `e`
 * and `w`, so only a line range), or follows a file (`tail -f`).
 */
const POSIX_VERBS: ReadonlyMap<string, VerbSpec> = new Map<string, VerbSpec>([
  ['cat', { flags: 'nbsaetvAET' }],
  ['head', { flags: 'qv', values: { n: COUNT, c: COUNT }, count: true }],
  ['tail', { flags: 'qv', values: { n: SIGNED_COUNT, c: SIGNED_COUNT }, count: true }],
  ['sed', { flags: 'n', values: { e: SED_RANGE }, long: { quiet: true, silent: true }, lead: 'script' }],
  ['grep', { flags: 'abcEFGHhIiLlnoPqsUvwxZz', values: { m: COUNT, A: COUNT, B: COUNT, C: COUNT, e: ANY }, long: { color: COLOR, colour: COLOR }, lead: 'pattern' }],
  ['cut', { flags: 'sz', values: { b: CUT_LIST, c: CUT_LIST, f: CUT_LIST, d: ONE_CHAR }, long: { complement: true } }],
  ['wc', { flags: 'lwcmL' }],
])

/**
 * The file operands of one command, or null when an argument is not one
 * `spec` allows. A glob may only be a file operand: expanded into a pattern,
 * an option or its value, it would shift what every later word means.
 */
function posixFiles(args: readonly PosixWord[], spec: VerbSpec): PosixWord[] | null {
  const operands: PosixWord[] = []
  let leads = 0
  let options = true
  for (let i = 0; i < args.length; i++) {
    const w = args[i]!.text
    if (!options || w === '-' || !w.startsWith('-')) { operands.push(args[i]!); continue }
    if (args[i]!.glob) return null
    if (w === '--') { options = false; continue }
    if (w.startsWith('--')) {
      const eq = w.indexOf('=')
      const kind = own(spec.long, w.slice(2, eq < 0 ? w.length : eq))
      if (kind === undefined || (kind === true ? eq >= 0 : eq < 0 || !kind.test(w.slice(eq + 1)))) return null
      continue
    }
    if (spec.count && COUNT.test(w.slice(1))) continue
    for (let j = 1; j < w.length; j++) {
      const flag = w[j]!
      if (spec.flags.includes(flag)) continue
      const shape = own(spec.values, flag)
      if (!shape) return null
      const next = j + 1 < w.length ? null : args[++i]
      if (next?.glob) return null
      const value = next === null ? w.slice(j + 1) : next?.text
      if (value === undefined || !shape.test(value)) return null
      if (flag === 'e') leads++
      break
    }
  }
  if (spec.lead === 'script') {
    // One script, from -e or as the first operand, and only a line range.
    if (leads === 0) {
      const script = operands.shift()
      if (!script || script.glob || !SED_RANGE.test(script.text)) return null
    } else if (leads > 1) return null
  } else if (spec.lead === 'pattern' && leads === 0) {
    const pattern = operands.shift()
    if (!pattern || pattern.glob) return null
  }
  return operands
}

/**
 * `p` read as Git Bash reads it, when it names a drive: `/c/dev/x` is
 * `c:/dev/x`. Only a command line Claude Code's Bash runs is read this way;
 * a file tool's path stays POSIX (#439).
 */
function msysDrive(p: string): string | null {
  const m = /^\/([a-z])(\/.*)?$/i.exec(p)
  return m ? `${m[1]}:${m[2] ?? '/'}` : null
}

/**
 * A path word made absolute against `cwd`, `..` resolved and its spelling
 * kept; null when it holds a backslash, is stdin or nothing, is relative with
 * no `cwd`, or is a spelling `normalise` fails closed on.
 *
 * A glob (`docs/guides/*.md`) is taken only in its last segment, after a
 * literal directory: the shell then expands it to entries directly in that
 * directory, each spelt `dir/name`, so none can turn into an option, and the
 * directory itself is checked like any other path, third-party folders
 * included. `**` is refused, since `globstar` makes it walk every folder below
 * (node_modules too), and so is a glob with no directory, whose expansions
 * could start with `-`. An expansion that is a directory prints an error, not
 * what is in it: no command here recurses.
 */
function posixPath(word: PosixWord, cwd: string | undefined): string | null {
  const p = word.text
  if (word.escaped || p === '' || p === '-') return null
  if (word.glob) {
    const slash = p.lastIndexOf('/')
    if (slash < 0 || p.includes('**') || /[*?]/.test(p.slice(0, slash))) return null
  }
  const abs = p.startsWith('/') || DRIVE_RE.test(p) ? p : cwd === undefined ? null : path.posix.join(cwd, p)
  return abs !== null && normalise(abs) !== null ? path.posix.normalize(abs) : null
}

/**
 * When a `cd` in one `&&` list still holds after the `;` that ends it. When
 * the `cd` fails, the shell runs what follows in the directory it was in
 * before, which a Bash call does not name. A `cd` into a configured root
 * fails only when the operator listed a directory that does not exist, so it
 * holds; a `cd` into a directory under one could name one that is not there,
 * so after the `;` relative names are not trusted. Measured on the 40,684
 * Claude Code Bash calls of 30 days of one developer's transcripts, as the
 * requests carried them: `never` trusted 832 reads, `root` 1,639, `any` 1,663.
 */
const CD_OUTLIVES_SEMICOLON: 'never' | 'root' | 'any' = 'root'

/**
 * The first file a POSIX command line reads under one of `roots`, when every
 * file it reads is under one and nothing in it can add output from anywhere
 * else; null otherwise. `msys` when Git Bash may run it (Claude Code's Bash).
 */
function posixReadPath(script: string, workdir: string | undefined, roots: readonly string[], msys: boolean): string | null {
  const tokens = lexPosix(script)
  if (!tokens) return null
  // `a | b && c ; d` is [[[a, b], [c]], [[d]]]: lists of `&&` lists of pipelines of commands.
  const lists: PosixWord[][][][] = [[[[]]]]
  for (const t of tokens) {
    const list = lists.at(-1)!
    const pipeline = list.at(-1)!
    const command = pipeline.at(-1)!
    if (!('op' in t)) { command.push(t); continue }
    if (command.length === 0) return null
    if (t.op === '|') pipeline.push([])
    else if (t.op === '&&') list.push([[]])
    else lists.push([[[]]])
  }
  // A trailing `;` leaves an empty list behind; a trailing `|` or `&&` an empty command.
  const last = lists.at(-1)!
  if (lists.length > 1 && last.length === 1 && last[0]!.length === 1 && last[0]![0]!.length === 0) lists.pop()

  const isRoot = (dir: string) => {
    const here = normalise(dir)
    const mapped = msys ? msysDrive(dir) : null
    const drive = mapped === null ? null : normalise(mapped)
    return roots.some(r => {
      const root = normalise(r)
      return root !== null && (root === here || root === drive)
    })
  }
  let cwd = workdir === undefined || normalise(workdir) === null ? undefined : path.posix.normalize(workdir.replace(/\\/g, '/'))
  let first: string | null = null
  for (const list of lists) {
    const before = cwd
    let cds = 0
    for (const pipeline of list) {
      if (pipeline.some(command => command.length === 0)) return null
      const head = pipeline[0]!
      if (head[0]!.text === 'cd') {
        if (pipeline.length !== 1 || head.length !== 2 || head[1]!.glob) return null
        const dir = posixPath(head[1]!, cwd)
        if (dir === null) return null
        cwd = dir
        cds++
        continue
      }
      for (let i = 0; i < pipeline.length; i++) {
        const [verb, ...args] = pipeline[i]!
        // echo writes its words, which the command line already shows.
        if (verb!.text === 'echo') {
          if (i > 0 || args.some(a => a.glob)) return null
          continue
        }
        const spec = POSIX_VERBS.get(verb!.text)
        const files = spec ? posixFiles(args, spec) : null
        // The first command of a pipeline has no input but the files it names.
        if (!files || (i === 0 && files.length === 0)) return null
        for (const f of files) {
          const p = posixPath(f, cwd)
          const drive = p !== null && msys ? msysDrive(p) : null
          const trusted = p !== null && underTrustedRoot(p, roots) ? p : drive !== null && underTrustedRoot(drive, roots) ? drive : null
          if (trusted === null) return null
          first ??= trusted
        }
      }
    }
    if (cwd !== before) {
      const holds = CD_OUTLIVES_SEMICOLON === 'any' || (CD_OUTLIVES_SEMICOLON === 'root' && cds === 1 && cwd !== undefined && isRoot(cwd))
      if (!holds) cwd = undefined
    }
  }
  return first
}
