import { describe, it, expect } from 'vitest'
import { SessionCostGates, addressCostKey } from '../../../src/detection/dos/sessionGates.js'
import { DEFAULT_CONFIG } from '../../../src/config/config.js'

describe('SessionCostGates (#912)', () => {
  it('keys an IPv6 address by its /64, and an IPv4 address whole', () => {
    expect(addressCostKey('2001:db8:1:2:aaaa::1')).toBe(addressCostKey('2001:0db8:0001:0002:ffff:ffff:ffff:ffff'))
    expect(addressCostKey('2001:db8:1:2::1')).not.toBe(addressCostKey('2001:db8:1:3::1'))
    expect(addressCostKey('::1')).toBe('0:0:0:0::/64')
    expect(addressCostKey('::ffff:10.0.0.7')).toBe('10.0.0.7')
    expect(addressCostKey('10.0.0.7')).not.toBe(addressCostKey('10.0.0.8'))
  })

  it('gives each tenant and each address its own gates, and one host rotating within its /64 the same', () => {
    const gates = new SessionCostGates({ ...DEFAULT_CONFIG.dos, maxRequestsPerMinute: 1 })
    expect(gates.forTenant('alpha').quota.checkRpm().allowed).toBe(true)
    expect(gates.forTenant('alpha').quota.checkRpm().allowed).toBe(false)
    expect(gates.forTenant('beta').quota.checkRpm().allowed).toBe(true)
    expect(gates.forAddress('2001:db8:1:2::1').quota.checkRpm().allowed).toBe(true)
    expect(gates.forAddress('2001:db8:1:2::2').quota.checkRpm().allowed).toBe(false)
  })

  it('never drops a tenant, however many addresses come and go', () => {
    const gates = new SessionCostGates({ ...DEFAULT_CONFIG.dos, maxRequestsPerMinute: 1 })
    gates.forTenant('alpha').quota.checkRpm()
    for (let i = 0; i < 10_050; i++) gates.forAddress(`10.${i >> 16 & 255}.${i >> 8 & 255}.${i & 255}`)
    expect(gates.forTenant('alpha').quota.checkRpm().allowed).toBe(false)
    expect(gates.size).toBe(10_001)
  })
})
