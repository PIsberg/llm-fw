import { describe, it, expect } from 'vitest'
import { ownsSinkhole } from '../../src/cli/sinkholeOwner.js'

// #617: the hosts-file marker is machine-wide. A second instance with its own
// LLM_FW_DIR (a dev run, a test server) adopted the installed instance's
// sinkhole, tried its port, and on a graceful exit would restore the hosts file
// and delete the 443 portproxy rule the installed instance depends on.
describe('who owns the sinkhole', () => {
  const base = { standalone: false, mode: 'proxy' as const, hostsHasSinkhole: false, customLlmFwDir: false }

  it('is this instance when its own config says sinkhole', () => {
    expect(ownsSinkhole({ ...base, mode: 'sinkhole' })).toBe(true)
    expect(ownsSinkhole({ ...base, mode: 'sinkhole', customLlmFwDir: true })).toBe(true)
  })

  it('is this instance on the default data dir when only the hosts marker says so (setup could not write config.json)', () => {
    expect(ownsSinkhole({ ...base, hostsHasSinkhole: true })).toBe(true)
  })

  it('is not an instance with its own data dir that only sees another install\'s hosts marker', () => {
    expect(ownsSinkhole({ ...base, hostsHasSinkhole: true, customLlmFwDir: true })).toBe(false)
  })

  it('is never a standalone server, which redirects nothing on this host', () => {
    expect(ownsSinkhole({ ...base, mode: 'sinkhole', standalone: true })).toBe(false)
    expect(ownsSinkhole({ ...base, hostsHasSinkhole: true, standalone: true })).toBe(false)
  })

  it('is nobody when neither says so', () => {
    expect(ownsSinkhole(base)).toBe(false)
  })
})
