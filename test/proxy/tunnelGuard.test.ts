import { describe, it, expect } from 'vitest'
import { isPrivilegedTunnelAddress, privilegedAddressGuard, TunnelRefused } from '../../src/proxy/tunnelGuard.js'

// GHSA-q53q-qg98-p9jf: a CONNECT tunnel is opened by the llm-fw process, so
// it reaches the host's own loopback and link-local services as a local
// caller would. These are the addresses a remote proxy client must not reach.
describe('isPrivilegedTunnelAddress', () => {
  it.each([
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '0.1.2.3', '169.254.169.254', '169.254.0.1',
    '::1', '::', 'fe80::1', 'febf::1', 'fd00:ec2::254',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:0.0.0.0',
    '[::1]', '[::ffff:127.0.0.1]',
  ])('refuses %s', (addr) => {
    expect(isPrivilegedTunnelAddress(addr)).toBe(true)
  })

  it.each([
    '192.168.1.10', '10.0.0.1', '172.16.0.1', '8.8.8.8', '128.0.0.1', '169.255.0.1',
    '2001:db8::1', 'fec0::1', 'fd00::1', '::ffff:8.8.8.8',
  ])('allows %s', (addr) => {
    expect(isPrivilegedTunnelAddress(addr)).toBe(false)
  })
})

describe('privilegedAddressGuard (the lookup a remote client\'s tunnel uses)', () => {
  const lookup = (host: string, all: boolean): Promise<unknown> => new Promise((resolve, reject) => {
    privilegedAddressGuard(host, { all }, (err: NodeJS.ErrnoException | null, result: unknown) => {
      if (err) reject(err)
      else resolve(result)
    })
  })

  it('refuses a name that resolves to loopback, in both callback forms', async () => {
    await expect(lookup('localhost', false)).rejects.toBeInstanceOf(TunnelRefused)
    await expect(lookup('localhost', true)).rejects.toBeInstanceOf(TunnelRefused)
  })

  it('never yields loopback for the numeric spellings of 127.0.0.1', async () => {
    // glibc's getaddrinfo turns these into 127.0.0.1, which the guard then
    // refuses; Windows does not resolve them at all. Either way, no tunnel.
    for (const host of ['2130706433', '0x7f.1', '127.1']) {
      const err = await lookup(host, false).then(() => null, (e: unknown) => e)
      expect(err, host).toBeInstanceOf(Error)
      if (!(err instanceof TunnelRefused)) expect((err as NodeJS.ErrnoException).code, host).toBe('ENOTFOUND')
    }
  })

  it('passes an ordinary address through unchanged', async () => {
    expect(await lookup('8.8.8.8', false)).toBe('8.8.8.8')
    expect(await lookup('8.8.8.8', true)).toEqual([{ address: '8.8.8.8', family: 4 }])
  })
})
