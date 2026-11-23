import { describe, it, expect } from 'vitest'
import { sniName } from '../../src/proxy/sni.js'

// #866: an IP literal was passed to tls.connect as `servername`. RFC 6066
// forbids an IP address in SNI, Node warns about it (DEP0123), and a strict
// upstream rejects the handshake.
describe('sniName', () => {
  it('names a host by its DNS name', () => {
    expect(sniName('api.anthropic.com')).toBe('api.anthropic.com')
    expect(sniName('vllm.svc.cluster.local')).toBe('vllm.svc.cluster.local')
  })

  it.each(['10.0.0.5', '127.0.0.1', '::1', '2001:db8::1', '[2001:db8::1]'])('sends no SNI for the IP literal %s', (ip) => {
    expect(sniName(ip)).toBeUndefined()
  })
})
