import { describe, it, expect, afterEach } from 'vitest'
import net from 'node:net'
import type tls from 'node:tls'
import { UpstreamPool } from '../../src/proxy/upstreamPool.js'

// #670: the pool only ever hands out a live connection for the key it was
// kept under, and lets go of one the other end closed or wrote to while idle.

const pairs: net.Socket[] = []
afterEach(() => { for (const s of pairs.splice(0)) s.destroy() })

/** A connected socket pair over loopback; the pool sees the first as a TLS socket. */
async function pair(): Promise<{ local: tls.TLSSocket; remote: net.Socket; server: net.Server }> {
  const server = net.createServer()
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
  const remote = new Promise<net.Socket>(r => server.once('connection', r))
  const local = net.connect((server.address() as net.AddressInfo).port, '127.0.0.1')
  await new Promise(r => local.once('connect', r))
  const other = await remote
  server.close()
  pairs.push(local, other)
  return { local: local as unknown as tls.TLSSocket, remote: other, server }
}

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms))

describe('UpstreamPool', () => {
  it('hands back the connection kept under the same key, and nothing under another', async () => {
    const pool = new UpstreamPool()
    const { local } = await pair()
    expect(pool.take('a:443:1.2.3.4')).toBeNull()
    pool.put('a:443:1.2.3.4', local)
    expect(pool.take('b:443:1.2.3.4')).toBeNull()
    expect(pool.take('a:443:1.2.3.4')).toBe(local)
    expect(pool.take('a:443:1.2.3.4')).toBeNull()
  })

  it('drops a connection the other end closed while it was idle', async () => {
    const pool = new UpstreamPool()
    const { local, remote } = await pair()
    pool.put('k', local)
    remote.end()
    await tick()
    expect(pool.size).toBe(0)
    expect(pool.take('k')).toBeNull()
    expect(local.destroyed).toBe(true)
  })

  it('drops a connection that sends anything while idle: it is no longer between messages', async () => {
    const pool = new UpstreamPool()
    const { local, remote } = await pair()
    pool.put('k', local)
    remote.write('HTTP/1.1 200 OK\r\n')
    await tick()
    expect(pool.take('k')).toBeNull()
    expect(local.destroyed).toBe(true)
  })

  it('closes a connection idle longer than its limit', async () => {
    const pool = new UpstreamPool(20)
    const { local } = await pair()
    pool.put('k', local)
    await tick(60)
    expect(pool.take('k')).toBeNull()
    expect(local.destroyed).toBe(true)
  })

  it('keeps at most maxPerKey connections per key and closes the rest', async () => {
    const pool = new UpstreamPool(30_000, 1)
    const a = await pair()
    const b = await pair()
    pool.put('k', a.local)
    pool.put('k', b.local)
    expect(b.local.destroyed).toBe(true)
    expect(pool.take('k')).toBe(a.local)
  })

  it('stops watching a connection it hands out, and closes what it still holds on close()', async () => {
    const pool = new UpstreamPool()
    const a = await pair()
    const b = await pair()
    pool.put('k', a.local)
    pool.put('j', b.local)
    const taken = pool.take('k')!
    a.remote.write('the next response')
    await tick()
    // The taker reads it now; the pool no longer destroys on data.
    expect(taken.destroyed).toBe(false)
    pool.close()
    expect(b.local.destroyed).toBe(true)
    expect(pool.size).toBe(0)
  })
})
