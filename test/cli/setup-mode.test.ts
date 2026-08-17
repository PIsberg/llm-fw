import { describe, it, expect } from 'vitest'
import { resolveSetupMode } from '../../src/cli/setup.js'

/**
 * `--sinkhole` was documented in a code comment as "an explicit synonym for the
 * default" but was never read: only `--proxy-only` was tested, so passing
 * `--sinkhole` unelevated set up proxy mode and said nothing about the mode the
 * user had asked for by name. A flag that is silently ignored is worse than one
 * that does not exist, because the user believes they configured something.
 */
describe('resolveSetupMode', () => {
  it('enables the sinkhole by default when elevated', () => {
    expect(resolveSetupMode([], true)).toEqual({ sinkhole: true, sinkholeWanted: true })
  })

  it('wants the sinkhole but degrades to proxy-only when not elevated', () => {
    // Unchanged behaviour: an unprivileged setup still configures proxy mode and
    // explains how to enable the sinkhole later.
    expect(resolveSetupMode([], false)).toEqual({ sinkhole: false, sinkholeWanted: true })
  })

  it('--proxy-only opts out even when elevated', () => {
    expect(resolveSetupMode(['--proxy-only'], true)).toEqual({ sinkhole: false, sinkholeWanted: false })
  })

  it('--sinkhole is honoured, not ignored', () => {
    expect(resolveSetupMode(['--sinkhole'], true)).toEqual({ sinkhole: true, sinkholeWanted: true })
  })

  it('refuses --sinkhole without elevation instead of quietly downgrading', () => {
    const mode = resolveSetupMode(['--sinkhole'], false)
    expect(mode.sinkhole).toBe(false)
    expect(mode.error).toMatch(/admin|root|elevat/i)
  })

  it('refuses the contradictory pair rather than picking a winner', () => {
    const mode = resolveSetupMode(['--proxy-only', '--sinkhole'], true)
    expect(mode.error).toBeTruthy()
    expect(mode.error).toContain('--proxy-only')
    expect(mode.error).toContain('--sinkhole')
  })

  it('ignores unrelated flags', () => {
    expect(resolveSetupMode(['--judge'], true)).toEqual({ sinkhole: true, sinkholeWanted: true })
  })
})
