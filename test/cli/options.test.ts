import { describe, it, expect } from 'vitest'
import { checkOptions, KNOWN_OPTIONS } from '../../src/cli/options.js'
import { USAGE } from '../../src/cli/usage.js'

/**
 * Subcommands read their flags with `args.includes(...)`, so anything else on
 * the command line was dropped without a word. `llm-fw start --obeserve`
 * started the firewall in enforce mode, and it refused the operator's own
 * Claude Code traffic they had asked it only to watch.
 */
describe('checkOptions', () => {
  it('rejects a misspelt flag and names the one that was meant', () => {
    const error = checkOptions('start', ['--obeserve'])
    expect(error).toContain('"--obeserve"')
    expect(error).toContain('--observe')
  })

  it('rejects a bare word where a flag was meant, and suggests the flag', () => {
    expect(checkOptions('start', ['observe'])).toContain('--observe')
  })

  it('rejects an unknown flag with no near miss without inventing a suggestion', () => {
    const error = checkOptions('start', ['--frobnicate'])
    expect(error).toContain('"--frobnicate"')
    expect(error).not.toContain('did you mean')
  })

  it('rejects a flag that belongs to a different subcommand', () => {
    expect(checkOptions('start', ['--proxy-only'])).toContain('"--proxy-only"')
  })

  it('rejects any argument to a subcommand that takes none', () => {
    expect(checkOptions('stop', ['--force'])).toContain('"--force"')
  })

  it('accepts every documented flag and alias', () => {
    expect(checkOptions('start', ['--standalone', '--gateway', '--observe'])).toBeUndefined()
    expect(checkOptions('start', ['--stand-alone', '--dry-run', '--monitor'])).toBeUndefined()
    expect(checkOptions('setup', ['--proxy-only', '--no-judge'])).toBeUndefined()
    expect(checkOptions('uninstall', ['-y', '--keep-model', '--purge'])).toBeUndefined()
    expect(checkOptions('doctor', ['--json'])).toBeUndefined()
    expect(checkOptions('--doctor', ['--json'])).toBeUndefined()
    expect(checkOptions('start', [])).toBeUndefined()
  })

  it('accepts the value after a flag that takes one, and only there', () => {
    expect(checkOptions('license', ['--activate', 'key/abc'])).toBeUndefined()
    expect(checkOptions('license', ['--activate-file', '/tmp/x.lfw-license'])).toBeUndefined()
    expect(checkOptions('license', ['--status', 'key/abc'])).toContain('"key/abc"')
  })

  it('leaves commands it does not know to the dispatcher', () => {
    expect(checkOptions('bogus', ['--anything'])).toBeUndefined()
  })

  // The table is what users can type, so every entry must be discoverable
  // from --help; aliases are the exception, accepted but not advertised.
  it('accepts only flags the help text documents, plus the named aliases', () => {
    const aliases = new Set(['--stand-alone', '--dry-run', '--monitor', '-y'])
    for (const [command, { flags, valued }] of Object.entries(KNOWN_OPTIONS)) {
      for (const flag of [...flags, ...valued]) {
        if (aliases.has(flag)) continue
        expect(USAGE, `${command} ${flag}`).toContain(flag)
      }
    }
  })
})
