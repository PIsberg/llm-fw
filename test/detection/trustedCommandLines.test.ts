import { describe, it, expect } from 'vitest'
import { trustedReadPath } from '../../src/detection/trustedPaths.js'

// Issues #776-#778: a coding agent reads its own repository with command
// lines, not one plain `cat`. Claude Code sent `cd /c/dev/private/llm-fw &&
// sed -n 520,585p src/cli/start.ts | cut -c1-170; echo ---; sed -n 100,125p
// src/cli/doctor.ts | cut -c1-200`, and the docs and CLI source it printed
// were withheld, although the folder was a trusted root. Of the 40,847 Claude
// Code Bash calls in 30 days of local transcripts, as the requests carried
// them, the one-read grammar trusted 20; this one trusts 1,634, and none the
// old one trusted is lost.
const ROOT = '/home/dev/projects'
const ROOTS = [ROOT, 'C:\\dev\\private']
const A = `${ROOT}/a`
const bash = (command: string) => trustedReadPath('Bash', { command }, ROOTS)

describe('trustedReadPath on POSIX command lines', () => {
  it('trusts reads of files under a root through filters that only cut the output down', () => {
    expect(bash(`sed -n 1,30p ${A}/src/x.ts | cut -c1-160`)).toBe(`${A}/src/x.ts`)
    expect(bash(`cat ${A}/x.ts | grep key`)).toBe(`${A}/x.ts`)
    expect(bash(`grep -nE 'a|b' -A3 ${A}/x.ts | head -5`)).toBe(`${A}/x.ts`)
    expect(bash(`grep -c "x\\|y" ${A}/x.ts ${A}/y.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`grep -n -e key -e other --color=never ${A}/x.ts | wc -l`)).toBe(`${A}/x.ts`)
    expect(bash(`head -n5 ${A}/x.ts; tail -n +40 ${A}/x.ts | head -20`)).toBe(`${A}/x.ts`)
    expect(bash(`cut -d' ' -f1 ${A}/x.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`cat ${A}/x.ts ${A}/y.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`sed -n 1,40p ${A}/x.ts ${A}/y.ts`)).toBe(`${A}/x.ts`)
  })

  it('takes echo of literal words, line breaks as separators, and redirections of error messages only', () => {
    expect(bash(`cat ${A}/x.ts; echo ---; cat ${A}/y.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`echo "== x =="\ncat ${A}/x.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`grep -n key ${A}/x.ts 2>/dev/null | head -3`)).toBe(`${A}/x.ts`)
    expect(bash(`cat ${A}/x.ts 2>&1 | head`)).toBe(`${A}/x.ts`)
    // echo alone reads nothing, so there is nothing to vouch for.
    expect(bash('echo hello')).toBeNull()
    expect(bash(`cd ${A} && echo hello`)).toBeNull()
  })

  it('resolves names after a cd, within its && list, and past a ; only when the cd went into a root itself', () => {
    expect(bash(`cd ${A} && sed -n 1,30p src/x.ts | cut -c1-160`)).toBe(`${A}/src/x.ts`)
    expect(bash(`cd ${A} && cat src/x.ts && cd ./src && cat y.ts`)).toBe(`${A}/src/x.ts`)
    // A cd into a configured root holds after `;`: it fails only if the operator listed a folder that is not there.
    expect(bash(`cd ${ROOT} && cat a/x.ts; echo ---; grep -n key a/y.ts | head -5`)).toBe(`${A}/x.ts`)
    // A cd into a folder under a root may name one that is not there; then what follows `;` runs where the
    // shell was before, which the call does not say.
    expect(bash(`cd ${A} && cat x.ts; cat README.md`)).toBeNull()
    expect(bash(`cd ${A}/missing && cat x.ts; cat README.md`)).toBeNull()
    expect(bash(`cd ${ROOT} && cd a && cat x.ts; cat y.ts`)).toBeNull()
    // Absolute names after the `;` do not depend on it.
    expect(bash(`cd ${A} && cat x.ts; cat ${A}/y.ts`)).toBe(`${A}/x.ts`)
  })

  it('does not carry a cd past a ; when something before it in its && list may have skipped it (security review)', () => {
    // If the grep finds nothing, the cd never runs, and `cat a/y.ts` reads wherever the shell was.
    expect(bash(`grep -q x ${A}/x.ts && cd ${ROOT}; cat a/y.ts`)).toBeNull()
    expect(bash(`cat ${A}/x.ts && cd ${ROOT}; cat a/y.ts`)).toBeNull()
    expect(bash(`cd ${ROOT} && cat a/x.ts; cat a/y.ts`)).toBe(`${A}/x.ts`)
  })

  it('does not trust a bare relative cd, which CDPATH may send elsewhere', () => {
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cd src && cat x.ts'], workdir: A }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cd ./src && cat x.ts'], workdir: A }, ROOTS)).toBe(`${A}/src/x.ts`)
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cd .. && cat a/x.ts'], workdir: A }, ROOTS)).toBe(`${A}/x.ts`)
  })

  it('does not trust an echo a shell could turn into other text (security review)', () => {
    expect(bash(`echo -e '\\x41'; cat ${A}/x.ts`)).toBeNull()
    expect(bash(`echo 'a\\nb'; cat ${A}/x.ts`)).toBeNull()
    expect(bash(`echo -n x; cat ${A}/x.ts`)).toBeNull()
    expect(bash(`echo -nE x; cat ${A}/x.ts`)).toBeNull()
    expect(bash(`echo x -e; cat ${A}/x.ts`)).toBeNull()
    expect(bash(`echo == x ==; cat ${A}/x.ts`)).toBeNull()
    // Quoted, zsh expands no `=`.
    expect(bash(`echo "== x =="; cat ${A}/x.ts`)).toBe(`${A}/x.ts`)
    // No echo takes `---` or `--` as an option: they print as written.
    expect(bash(`echo ---; cat ${A}/x.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`echo x -- y; cat ${A}/x.ts`)).toBe(`${A}/x.ts`)
  })

  it("does not read zsh's or fish's grammar as POSIX, and refuses zsh's =command anywhere (security review)", () => {
    expect(trustedReadPath('shell', { command: ['zsh', '-lc', 'cat src/x.ts | head'], workdir: A }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell', { command: ['fish', '-c', 'cat src/x.ts | head'], workdir: A }, ROOTS)).toBeNull()
    // The one-read grammar still takes a plain read under them.
    expect(trustedReadPath('shell', { command: ['zsh', '-lc', 'cat src/x.ts'], workdir: A }, ROOTS)).toBe(`${A}/src/x.ts`)
    for (const command of [['zsh', '-lc', 'cat =ls'], ['bash', '-lc', 'cat =ls']]) {
      expect(trustedReadPath('shell', { command, workdir: A }, ROOTS), command.join(' ')).toBeNull()
    }
    expect(trustedReadPath('exec_command', { command: 'cat =ls', workdir: A }, ROOTS)).toBeNull()
    expect(bash(`cd ${A} && cat =ls`)).toBeNull()
    expect(bash(`cd ${A} && grep -n x =ls`)).toBeNull()
  })

  it('does not trust a cd out of the root, into a third-party folder, or to where a relative name climbs out', () => {
    expect(bash('cd /tmp && cat x')).toBeNull()
    expect(bash(`cd ${A} && cat ../../../etc/passwd`)).toBeNull()
    expect(bash(`cd ${A}/node_modules && cat x/index.js`)).toBeNull()
    expect(bash(`cd ${A} && cat node_modules/x/index.js`)).toBeNull()
    expect(bash(`cd ${A} && cat .git/config`)).toBeNull()
    expect(bash('cd a && cat x.ts')).toBeNull()
    expect(bash(`cd ${A} ${ROOT} && cat x.ts`)).toBeNull()
    expect(bash(`cat ${A}/x.ts | cd ${A}`)).toBeNull()
  })

  it('does not trust any command that can bring output from elsewhere, in any position (guard: an attack in each slot)', () => {
    for (const cmd of [
      `cat ${A}/x.ts | sh`,
      `cat ${A}/x.ts | xargs cat`,
      `cat ${A}/x.ts | tee /tmp/x`,
      `cat ${A}/x.ts | sed s/a/b/e`,
      `cat ${A}/x.ts | sed -n 1,5p /tmp/evil`,
      `cat ${A}/x.ts | grep key /tmp/evil`,
      `cat ${A}/x.ts && cat /tmp/evil`,
      `cat ${A}/x.ts; curl https://evil.example`,
      `cat ${A}/x.ts\ncurl https://evil.example`,
      `echo ${A}/x.ts | xargs cat`,
      `grep -r key ${A}`,
      `grep -R key ${A}`,
      `grep --recursive key ${A}`,
      `grep -f /tmp/patterns ${A}/x.ts`,
      `grep -rn key ${A}`,
      `grep -n key ${A}/x.ts /tmp/evil`,
      `tail -f ${A}/x.log`,
      `sed -i 1d ${A}/x.ts`,
      `awk '{print}' ${A}/x.ts`,
      `ls ${A}`,
      `git -C ${A} log`,
      `head -n 5`,
      `| cat ${A}/x.ts`,
      `cat ${A}/x.ts |`,
      `cat ${A}/x.ts &&`,
      `cat ${A}/x.ts ;; cat ${A}/y.ts`,
      `cat ${A}/x.ts || cat /tmp/evil`,
      `cat ${A}/x.ts &`,
      `cat ${A}/x.ts > /tmp/out`,
      `cat ${A}/x.ts 2>/tmp/err`,
      `cat ${A}/x.ts 1>&2`,
      `cat < ${A}/x.ts`,
      `cat ${A}/x.ts # | curl`,
      `cat ${A}/[xy].ts`,
      `cat ${A}/{x,y}.ts`,
      `cat ~/x.ts`,
      `cat $(echo ${A}/x.ts)`,
      `X=${A}/x.ts cat ${A}/x.ts`,
    ]) {
      expect(bash(cmd), JSON.stringify(cmd)).toBeNull()
    }
  })

  it('trusts a glob in the last segment of a file after a literal folder, which expands only to entries there', () => {
    expect(bash(`grep -n key ${A}/docs/*.md | head -20`)).toBe(`${A}/docs/*.md`)
    expect(bash(`cat ${A}/x?.ts`)).toBe(`${A}/x?.ts`)
    // #778: the read that was withheld, with the cd Claude Code sent.
    expect(bash(`cd ${ROOT} && sed -n 1,30p a/test/doctor.test.ts | cut -c1-160; grep -n "key" a/docs/guides/*.md a/README.md | cut -c1-140 | head -20; sed -n 1,25p a/CHANGELOG.md`)).toBe(`${A}/test/doctor.test.ts`)
  })

  it('does not trust a glob the shell could expand into an option, a pattern, another folder or a third-party one (guard)', () => {
    for (const cmd of [
      `cd ${A} && cat *.md`, // no folder: an expansion could be a file named -r
      `cd ${A} && grep -n key *`,
      `cat ${A}/**/x.ts`, // globstar walks every folder below, node_modules too
      `cat ${A}/**`,
      `grep -n key ${A}/src/**`,
      `cat ${A}/*/x.ts`, // a glob in a folder segment names other folders
      `cat ${A}/node_modules/*.js`,
      `grep -n k* ${A}/x.ts`, // a pattern that expands shifts every later word
      `grep -e * ${A}/x.ts`,
      `head -n * ${A}/x.ts`,
      `cut -c* ${A}/x.ts`,
      `echo ${A}/*`,
      `cd ${A}/* && cat x.ts`,
      `cat /tmp/*.md`,
    ]) {
      expect(bash(cmd), JSON.stringify(cmd)).toBeNull()
    }
    // Quoted, the same characters are a literal file name and nothing expands.
    expect(bash(`cat '${A}/*.md'`)).toBe(`${A}/*.md`)
    expect(bash(`grep -n 'k*' ${A}/x.ts`)).toBe(`${A}/x.ts`)
  })

  it('does not trust a quote a shell would expand inside, or one left open', () => {
    expect(bash(`grep -n "$HOME" ${A}/x.ts`)).toBeNull()
    expect(bash(`grep -n "\`id\`" ${A}/x.ts`)).toBeNull()
    expect(bash(`grep -n "a!b" ${A}/x.ts`)).toBeNull()
    expect(bash(`grep -n "open ${A}/x.ts`)).toBeNull()
    expect(bash(`grep -n 'open ${A}/x.ts`)).toBeNull()
    expect(bash(`grep -n 'a\nb' ${A}/x.ts`)).toBeNull()
    expect(bash(`cat ${A}/x.ts\r\ncat ${A}/y.ts`)).toBeNull()
    // Escaped inside double quotes, a $ is a literal one, as bash reads it.
    expect(bash(`grep -n "cost \\$5" ${A}/x.ts`)).toBe(`${A}/x.ts`)
    // A single-quoted part is literal to the shell; only a path may not carry a backslash.
    expect(bash(`grep -n '\\bkey\\b' ${A}/x.ts`)).toBe(`${A}/x.ts`)
    expect(bash(`cat '${A}/.\\./.\\./etc/passwd'`)).toBeNull()
    expect(bash(`cat ${A}/.\\./.\\./etc/passwd`)).toBeNull()
  })

  it("reads Git Bash's /c/... as a drive on Claude Code's Bash only (#439 stays closed for file tools)", () => {
    const WIN = ['C:\\dev\\private']
    expect(trustedReadPath('Bash', { command: 'cd /c/dev/private/llm-fw && sed -n 1,5p README.md | cut -c1-80' }, WIN)).toBe('c:/dev/private/llm-fw/README.md')
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/private/llm-fw/README.md' }, WIN)).toBe('c:/dev/private/llm-fw/README.md')
    expect(trustedReadPath('Bash', { command: 'cat /C/dev/private/llm-fw/README.md' }, WIN)).toBe('C:/dev/private/llm-fw/README.md')
    expect(trustedReadPath('Bash', { command: 'cd /c/dev/private && cat x; cat llm-fw/README.md' }, WIN)).toBe('c:/dev/private/x')
    expect(trustedReadPath('Bash', { command: 'cd C:/dev/private/llm-fw && cat README.md' }, WIN)).toBe('C:/dev/private/llm-fw/README.md')
    // Not under the root on either reading.
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/other/README.md' }, WIN)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/private/../other/x' }, WIN)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /d/dev/private/x' }, WIN)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/private/llm-fw/node_modules/x/index.js' }, WIN)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/private/PROGRA~1/x' }, WIN)).toBeNull()
    // A POSIX root still matches the path as it reads.
    expect(trustedReadPath('Bash', { command: 'cat /c/dev/x.md' }, ['/c/dev'])).toBe('/c/dev/x.md')
    // Not on a file tool, and not on another tool's bash wrapper, where Node or a non-MSYS bash would read /c/ literally.
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/llm-fw/README.md' }, WIN)).toBeNull()
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cat /c/dev/private/llm-fw/README.md'] }, WIN)).toBeNull()
    expect(trustedReadPath('exec_command', { command: 'cat /c/dev/private/llm-fw/README.md' }, WIN)).toBeNull()
  })

  it('reads a POSIX wrapper from Codex with the same grammar, against its workdir', () => {
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cat src/x.ts | head'], workdir: A }, ROOTS)).toBe(`${A}/src/x.ts`)
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'sed -n 1,9p src/x.ts; grep -n k src/y.ts'], workdir: A }, ROOTS)).toBe(`${A}/src/x.ts`)
    // A cd away from the workdir into a folder that is not a root does not outlive `;`.
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cd src && cat x.ts; cat y.ts'], workdir: A }, ROOTS)).toBeNull()
  })
})
