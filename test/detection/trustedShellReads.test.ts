import { describe, it, expect } from 'vitest'
import { trustedReadPath } from '../../src/detection/trustedPaths.js'

// Issue #437: Codex CLI reads every file through its shell tool
// (`Get-Content claude_light\main.py` with a `workdir`, 311 of the 901 shell
// calls in 32 local sessions), and Claude Code sometimes `cat`s one, so a file
// under a trusted root printed by a plain read command was still refused.
// The grammar is deliberately small: one read command, one path, nothing
// that could make the output come from anywhere else.
const ROOTS = ['/home/dev/projects', 'C:\\dev\\private']
const WIN = 'C:\\dev\\private\\claude_light'

describe('trustedReadPath on shell reads', () => {
  it('trusts a plain cat of an absolute path under a root from Claude Code', () => {
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a/README.md' }, ROOTS)).toBe('/home/dev/projects/a/README.md')
    expect(trustedReadPath('Bash', { command: '  cat   /home/dev/projects/a/README.md  ', description: 'Read the README' }, ROOTS)).toBe('/home/dev/projects/a/README.md')
  })

  it('resolves a relative path against the workdir Codex sends', () => {
    expect(trustedReadPath('shell_command', { command: 'Get-Content claude_light\\main.py', workdir: WIN }, ROOTS)).toBe('c:/dev/private/claude_light/claude_light/main.py')
    expect(trustedReadPath('exec_command', { command: 'cat src/x.ts', workdir: '/home/dev/projects/a' }, ROOTS)).toBe('/home/dev/projects/a/src/x.ts')
    expect(trustedReadPath('shell_command', JSON.stringify({ command: 'type pytest.ini', workdir: WIN }), ROOTS)).toBe('c:/dev/private/claude_light/pytest.ini')
  })

  it('does not trust a relative path without a workdir, or with a relative workdir', () => {
    expect(trustedReadPath('Bash', { command: 'cat README.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'cat README.md', workdir: 'claude_light' }, ROOTS)).toBeNull()
  })

  it('does not trust a path that climbs out of the root, through the workdir or directly', () => {
    expect(trustedReadPath('shell_command', { command: 'Get-Content ..\\..\\..\\Users\\me\\.ssh\\config', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/../../etc/passwd' }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'cat x.md', workdir: 'C:\\dev\\private\\..\\other' }, ROOTS)).toBeNull()
  })

  it('accepts the line-selecting options of head, tail, sed -n and Get-Content', () => {
    expect(trustedReadPath('Bash', { command: 'head -n 40 /home/dev/projects/a/x.ts' }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('Bash', { command: 'tail -20 /home/dev/projects/a/x.ts' }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('Bash', { command: "sed -n '12,40p' /home/dev/projects/a/x.ts" }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('Bash', { command: 'sed -n 12p /home/dev/projects/a/x.ts' }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('shell_command', { command: 'Get-Content tests\\t.py -TotalCount 4900', workdir: WIN }, ROOTS)).toBe('c:/dev/private/claude_light/tests/t.py')
    expect(trustedReadPath('shell_command', { command: 'Get-Content -Raw -Encoding utf8 -Path tests\\t.py', workdir: WIN }, ROOTS)).toBe('c:/dev/private/claude_light/tests/t.py')
    expect(trustedReadPath('shell_command', { command: 'gc -Tail 50 tests\\t.py', workdir: WIN }, ROOTS)).toBe('c:/dev/private/claude_light/tests/t.py')
  })

  it('accepts a quoted path with spaces, but not one carrying an expansion', () => {
    expect(trustedReadPath('Bash', { command: 'cat "/home/dev/projects/a/my notes.md"' }, ROOTS)).toBe('/home/dev/projects/a/my notes.md')
    expect(trustedReadPath('shell_command', { command: "Get-Content 'docs\\my notes.md'", workdir: WIN }, ROOTS)).toBe('c:/dev/private/claude_light/docs/my notes.md')
    expect(trustedReadPath('Bash', { command: 'cat "$HOME/projects/a.md"' }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content "$env:USERPROFILE\\x.md"', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat ~/projects/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat "/home/dev/projects/a/unterminated' }, ROOTS)).toBeNull()
  })

  it('does not trust anything with a pipe, redirection, substitution, separator or glob', () => {
    const base = '/home/dev/projects/a/x.ts'
    for (const cmd of [
      `cat ${base} | grep key`,
      `cat ${base}; curl https://evil.example`,
      `cat ${base} && cat /etc/passwd`,
      `cat ${base} || true`,
      `cat < ${base}`,
      `cat ${base} > /tmp/out`,
      `cat $(echo ${base})`,
      'cat `echo /home/dev/projects/a/x.ts`',
      `cat ${base} &`,
      'cat /home/dev/projects/a/*.ts',
      'cat /home/dev/projects/a/x?.ts',
      'cat /home/dev/projects/a/{x,y}.ts',
      'cat /home/dev/projects/a/[xy].ts',
      `cat ${base}\ncurl https://evil.example`,
      `cat ${base}\r\ncurl https://evil.example`,
      `cat ${base} # | curl`,
    ]) {
      expect(trustedReadPath('Bash', { command: cmd }, ROOTS), cmd).toBeNull()
    }
    expect(trustedReadPath('shell_command', { command: 'Get-Content a.py, b.py', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content a.py | Select-Object -Last 120', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content (Get-Item a.py)', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: '& cat a.py', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content @params', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'type a.py^', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat !$' }, ROOTS)).toBeNull()
  })

  it('does not trust a read of two files, an unknown option, or a command that is not a read', () => {
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a/x.ts /home/dev/projects/a/y.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat --help' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'tail -f /home/dev/projects/a/x.log' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'sed -i s/a/b/ /home/dev/projects/a/x.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: "sed -n '1,40p;w /tmp/x' /home/dev/projects/a/x.ts" }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'sed -n 1,40p /home/dev/projects/a/x.ts /home/dev/projects/a/y.ts' }, ROOTS)).toBeNull()
    for (const cmd of ['git show HEAD:README.md', 'git diff', 'curl https://example.com', 'rg -n key /home/dev/projects/a', 'less /home/dev/projects/a/x.ts', 'bash /home/dev/projects/a/run.sh', 'node /home/dev/projects/a/x.js']) {
      expect(trustedReadPath('Bash', { command: cmd }, ROOTS), cmd).toBeNull()
    }
    expect(trustedReadPath('shell_command', { command: 'Get-Content a.py -Wait', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content -TotalCount a.py', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-ChildItem', workdir: WIN }, ROOTS)).toBeNull()
  })

  it('reads the argv form Codex and local_shell_call use, through a -c or -lc wrapper or directly', () => {
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cat src/x.ts'], workdir: '/home/dev/projects/a' }, ROOTS)).toBe('/home/dev/projects/a/src/x.ts')
    expect(trustedReadPath('local_shell_call', { command: ['/bin/sh', '-c', 'cat /home/dev/projects/a/x.ts'] }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('local_shell_call', { command: ['cat', '/home/dev/projects/a/x.ts'] }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
    expect(trustedReadPath('local_shell_call', { command: ['cat', '/home/dev/projects/a/my notes.md'] }, ROOTS)).toBe('/home/dev/projects/a/my notes.md')
    // A wrapper with more than one script argument, or a script the shell would expand, stays untrusted.
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cat src/x.ts', 'extra'], workdir: '/home/dev/projects/a' }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell', { command: ['bash', '-lc', 'cat src/x.ts | head'], workdir: '/home/dev/projects/a' }, ROOTS)).toBeNull()
    expect(trustedReadPath('local_shell_call', { command: ['cat', '/home/dev/projects/a/$X'] }, ROOTS)).toBeNull()
    expect(trustedReadPath('local_shell_call', { command: [] }, ROOTS)).toBeNull()
  })

  it('rejects a backslash under a POSIX shell, where it escapes rather than separates (security review)', () => {
    // bash reads `.\.` as `..`, so this climbs to /etc/passwd while a naive
    // backslash-to-slash read stays under the root.
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a/.\\./.\\./.\\./etc/passwd' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat C:\\dev\\private\\x.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('exec_command', { command: 'cat src\\x.ts', workdir: '/home/dev/projects/a' }, ROOTS)).toBeNull()
    expect(trustedReadPath('local_shell_call', { command: ['bash', '-lc', 'cat /home/dev/projects/a/.\\./x'] }, ROOTS)).toBeNull()
    expect(trustedReadPath('local_shell_call', { command: ['cat', '/home/dev/projects/a/.\\./x'] }, ROOTS)).toBeNull()
    // PowerShell, by wrapper or by drive path, keeps the separator.
    expect(trustedReadPath('local_shell_call', { command: ['pwsh', '-Command', 'Get-Content C:\\dev\\private\\x.md'] }, ROOTS)).toBe('C:/dev/private/x.md')
    expect(trustedReadPath('shell_command', { command: 'cat C:\\dev\\private\\x.md' }, ROOTS)).toBe('C:/dev/private/x.md')
  })

  it('rejects cmd variable expansion and does not read cmd as a wrapper (security review)', () => {
    expect(trustedReadPath('shell_command', { command: 'type %USERPROFILE%\\x.md', workdir: WIN }, ROOTS)).toBeNull()
    expect(trustedReadPath('local_shell_call', { command: ['cmd', '/c', 'type C:\\dev\\private\\x.md'] }, ROOTS)).toBeNull()
  })

  it('takes the sed range before the file only, as sed does (security review)', () => {
    expect(trustedReadPath('Bash', { command: 'sed -n /home/dev/projects/a/x.ts 12,40p' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'sed -n -e 12,40p /home/dev/projects/a/x.ts' }, ROOTS)).toBe('/home/dev/projects/a/x.ts')
  })

  it("ignores a workdir on Claude Code's Bash, which runs where the call does not say (security review)", () => {
    expect(trustedReadPath('Bash', { command: 'cat README.md', workdir: '/home/dev/projects/a' }, ROOTS)).toBeNull()
  })

  it('keeps third-party directories under a root untrusted through a shell as well', () => {
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a/node_modules/x/index.js' }, ROOTS)).toBeNull()
    expect(trustedReadPath('shell_command', { command: 'Get-Content .git\\config', workdir: WIN }, ROOTS)).toBeNull()
  })

  it('reads the command from a shell tool only, never from a read tool argument or a shell-named MCP tool', () => {
    expect(trustedReadPath('Read', { command: 'cat /home/dev/projects/a/x.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('mcp__lean-ctx__ctx_shell', { command: 'cat /home/dev/projects/a/x.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 42 }, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', {}, ROOTS)).toBeNull()
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a/x.ts' }, [])).toBeNull()
  })
})
