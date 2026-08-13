import { describe, it, expect } from 'vitest'
import {
  authorizeClient,
  credentialFromAuthHeader,
  isLocalBind,
  isLoopbackAddr,
  presentedProxyToken,
  resolveAuthPolicy,
  tokenMatches,
} from '../../src/auth.js'

describe('credentialFromAuthHeader', () => {
  it('reads a Bearer token', () => {
    expect(credentialFromAuthHeader('Bearer abc123')).toBe('abc123')
  })

  it('reads the password half of a Basic credential', () => {
    const encoded = Buffer.from('llm-fw:s3cret').toString('base64')
    expect(credentialFromAuthHeader(`Basic ${encoded}`)).toBe('s3cret')
  })

  it('tolerates a Basic credential with no username', () => {
    const encoded = Buffer.from(':s3cret').toString('base64')
    expect(credentialFromAuthHeader(`Basic ${encoded}`)).toBe('s3cret')
  })

  it('returns empty for a missing or unrecognised scheme', () => {
    expect(credentialFromAuthHeader(undefined)).toBe('')
    expect(credentialFromAuthHeader('Digest nonce=1')).toBe('')
  })
})

describe('presentedProxyToken', () => {
  it('reads Proxy-Authorization, not Authorization', () => {
    // The client's own upstream API key travels in `authorization`. Reading it
    // here would let a caller authenticate to the proxy with the provider key.
    expect(presentedProxyToken({ 'proxy-authorization': 'Bearer proxytok' })).toBe('proxytok')
    expect(presentedProxyToken({ authorization: 'Bearer sk-upstream' })).toBe('')
  })
})

describe('isLocalBind', () => {
  it('treats loopback and an unset bind as local', () => {
    expect(isLocalBind('127.0.0.1')).toBe(true)
    expect(isLocalBind('::1')).toBe(true)
    expect(isLocalBind(undefined)).toBe(true)
  })

  it('treats a wildcard or LAN bind as remote-reachable', () => {
    expect(isLocalBind('0.0.0.0')).toBe(false)
    expect(isLocalBind('192.168.1.50')).toBe(false)
  })
})

describe('resolveAuthPolicy', () => {
  it('demands a credential as soon as the listener is bound off-host', () => {
    const policy = resolveAuthPolicy({ bindHost: '0.0.0.0' })
    expect(policy.required).toBe(true)
    expect(policy.generated).toBe(true)
    expect(policy.token).toHaveLength(48)
  })

  it('stays off for a local-only listener', () => {
    expect(resolveAuthPolicy({ bindHost: '127.0.0.1' }).required).toBe(false)
    expect(resolveAuthPolicy({}).required).toBe(false)
  })

  it('uses the configured token rather than generating one', () => {
    const policy = resolveAuthPolicy({ bindHost: '0.0.0.0', authToken: 'pinned-token' })
    expect(policy.token).toBe('pinned-token')
    expect(policy.generated).toBe(false)
  })

  it('an explicit requireAuth:true drops the loopback exemption', () => {
    const policy = resolveAuthPolicy({ requireAuth: true, bindHost: '127.0.0.1' })
    expect(policy.required).toBe(true)
    expect(policy.exemptLoopback).toBe(false)
  })

  it('an explicit requireAuth:false disables the check on a public bind', () => {
    expect(resolveAuthPolicy({ requireAuth: false, bindHost: '0.0.0.0' }).required).toBe(false)
  })
})

describe('authorizeClient', () => {
  const remote = resolveAuthPolicy({ bindHost: '0.0.0.0', authToken: 'good-token' })

  it('rejects a remote client with no or wrong credential', () => {
    expect(authorizeClient(remote, '192.168.1.9', '')).toBe(false)
    expect(authorizeClient(remote, '192.168.1.9', 'bad-token')).toBe(false)
  })

  it('accepts a remote client with the right credential', () => {
    expect(authorizeClient(remote, '192.168.1.9', 'good-token')).toBe(true)
  })

  it('exempts loopback when the requirement was inferred from the bind', () => {
    expect(authorizeClient(remote, '127.0.0.1', '')).toBe(true)
  })

  it('does not exempt loopback when auth was demanded explicitly', () => {
    const strict = resolveAuthPolicy({ requireAuth: true, authToken: 'good-token' })
    expect(authorizeClient(strict, '127.0.0.1', '')).toBe(false)
    expect(authorizeClient(strict, '127.0.0.1', 'good-token')).toBe(true)
  })
})

describe('tokenMatches', () => {
  it('compares whole tokens only', () => {
    expect(tokenMatches('s3cret-token', 's3cret-token')).toBe(true)
    expect(tokenMatches('s3cret', 's3cret-token')).toBe(false)
    expect(tokenMatches('', 's3cret-token')).toBe(false)
    expect(tokenMatches('s3cret-token', '')).toBe(false)
  })
})

describe('isLoopbackAddr', () => {
  it('covers the IPv4-mapped IPv6 form', () => {
    expect(isLoopbackAddr('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackAddr('10.0.0.5')).toBe(false)
  })
})
