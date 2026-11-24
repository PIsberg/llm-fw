import { describe, it, expect } from 'vitest'
import { isLoopbackAddr, isLocalBind, resolveAuthPolicy } from '../src/auth.js'

// #920: spellings of loopback the checks did not recognise.
describe('loopback spellings (#920)', () => {
  it.each(['::FFFF:127.0.0.1', '::ffff:127.0.0.1', '0:0:0:0:0:0:0:1', '0000:0000:0000:0000:0000:0000:0000:0001', '::0:1', '[::1]'])('%s is loopback', (a) => {
    expect(isLoopbackAddr(a)).toBe(true)
  })

  it.each(['::2', '::ffff:10.0.0.1', '0:0:0:0:0:0:0:2', '1::1'])('%s is not', (a) => {
    expect(isLoopbackAddr(a)).toBe(false)
  })

  it('a listener bound to localhost is a local bind, so it needs no token', () => {
    expect(isLocalBind('localhost')).toBe(true)
    expect(isLocalBind('LocalHost')).toBe(true)
    expect(resolveAuthPolicy({ bindHost: 'localhost' }).required).toBe(false)
  })
})
