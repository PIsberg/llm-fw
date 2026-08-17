import { describe, it, expect } from 'vitest'
import { USAGE } from '../../src/cli/usage.js'

/**
 * `--gateway` and `--observe` are real, tested, documented-in-the-README flags
 * that `llm-fw --help` did not mention, so the only way to discover them was to
 * read the source or the README. Help output is the first place anyone looks.
 */
describe('CLI usage text', () => {
  const flags = ['--standalone', '--gateway', '--observe', '--proxy-only', '--sinkhole']

  for (const flag of flags) {
    it(`documents ${flag}`, () => {
      expect(USAGE).toContain(flag)
    })
  }

  it('lists every subcommand the CLI dispatches', () => {
    for (const cmd of [
      'setup', 'setup-judge', 'uninstall', 'start', 'stop', 'status',
      'doctor', 'install-service', 'uninstall-service', 'license',
    ]) {
      expect(USAGE).toContain(cmd)
    }
  })

  it('still carries the licence boundary', () => {
    expect(USAGE).toContain('PolyForm Noncommercial')
  })
})
