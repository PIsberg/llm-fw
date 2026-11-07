import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import tls from 'node:tls'
import { issueUpstreamCert } from './lib/tls-trust.js'
import { TlsSessionCache } from '../../src/proxy/tlsSessions.js'

// #670: every upstream request paid a full TLS handshake, about 35-40 ms to
// the providers measured. Resuming the last session per host saves the
// handshake's extra work without changing how a response is framed.
describe('TlsSessionCache', () => {
  let server: tls.Server
  let port = 0
  let ca = ''
  const reused: boolean[] = []

  beforeAll(async () => {
    const cert = issueUpstreamCert('api.example.test')
    ca = cert.ca
    server = tls.createServer({ key: cert.key, cert: cert.cert }, socket => {
      reused.push(socket.isSessionReused())
      socket.end('ok')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }, 60_000)

  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())) })

  /** One request's worth of connection: connect, read until close. */
  function roundTrip(cache: TlsSessionCache | null, servername = 'api.example.test'): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const opts = { host: '127.0.0.1', port, servername, ca }
      const socket = cache ? cache.connect(opts) : tls.connect(opts)
      let resumed = false
      socket.on('secureConnect', () => { resumed = socket.isSessionReused() })
      socket.on('error', reject)
      socket.on('data', () => {})
      socket.on('close', () => resolve(resumed))
    })
  }

  it('resumes the session of the previous connection to the same host', async () => {
    reused.length = 0
    const cache = new TlsSessionCache()
    expect(await roundTrip(cache)).toBe(false)
    expect(await roundTrip(cache)).toBe(true)
    expect(await roundTrip(cache)).toBe(true)
    expect(reused).toEqual([false, true, true])
  })

  it('keeps sessions apart by server name and port', async () => {
    const cache = new TlsSessionCache()
    await roundTrip(cache, 'api.example.test')
    expect(cache.size).toBe(1)
    // A different name has no session of its own to offer.
    expect(cache.get('other.example.test', port)).toBeUndefined()
    expect(cache.get('api.example.test', port + 1)).toBeUndefined()
    expect(cache.get('api.example.test', port)).toBeInstanceOf(Buffer)
  })

  it('forgets a host\'s session when a connection with it fails, and holds a bounded number of hosts', () => {
    const cache = new TlsSessionCache(2)
    cache.set('a', 443, Buffer.from('a'))
    cache.set('b', 443, Buffer.from('b'))
    cache.set('c', 443, Buffer.from('c'))
    expect(cache.size).toBe(2)
    expect(cache.get('a', 443)).toBeUndefined()
    cache.forget('b', 443)
    expect(cache.get('b', 443)).toBeUndefined()
  })

  it('without the cache, nothing is resumed', async () => {
    expect(await roundTrip(null)).toBe(false)
    expect(await roundTrip(null)).toBe(false)
  })
})
