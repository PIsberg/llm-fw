import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { CertFactory } from '../../src/proxy/certs.js'

// GHSA-q53q-qg98-p9jf. A forward proxy exposed to the network opened CONNECT
// tunnels to any address, and the tunnel arrives at the target from
// 127.0.0.1. A client holding only the proxy token could therefore reach the
// dashboard (which exempts loopback from its token), a loopback-bound gateway
// (and the provider keys it holds) and the cloud metadata endpoint.
//
// The property only exists for a client that is NOT on loopback, so unlike
// proxy-auth.e2e.test.ts this suite binds the proxy, behind a token, to this
// machine's own non-loopback address for its duration and connects from it.
// It skips where no such interface exists.
const lanAddress = Object.values(os.networkInterfaces()).flat()
  .find(a => a && !a.internal && a.family === 'IPv4')?.address

async function sendConnect(proxyHost: string, proxyPort: number, target: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: proxyHost, port: proxyPort })
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CONNECT timed out')) }, 5000)
    socket.once('connect', () => {
      const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${extra}\r\n`)
    })
    let buffer = ''
    socket.on('data', (c) => {
      buffer += c.toString('binary')
      if (!buffer.includes('\r\n\r\n')) return
      clearTimeout(timer)
      socket.destroy()
      resolve(parseInt((buffer.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10))
    })
    socket.on('error', (err) => { clearTimeout(timer); reject(err) })
    socket.on('close', () => { clearTimeout(timer); if (!buffer.includes('\r\n\r\n')) reject(new Error('closed without response')) })
  })
}

describe.skipIf(!lanAddress)('Proxy tunnel guard E2E (remote client)', { timeout: 30000 }, () => {
  const PORT = 18141
  const TOKEN = 'tunnel-guard-token'
  const auth = { 'Proxy-Authorization': `Bearer ${TOKEN}` }
  let tempDir: string
  let proxy: ProxyServer
  let loopbackService: net.Server
  let lanService: net.Server
  let loopbackPort: number
  let lanPort: number

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(os.tmpdir(), 'llm-fw-tunnel-guard-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()

    // Stand-ins for a loopback-only service (the dashboard) and an ordinary
    // host on the network. Both end every connection at once.
    const sink = (): net.Server => net.createServer((s) => { s.on('error', () => {}); s.end() })
    loopbackService = sink()
    lanService = sink()
    await new Promise<void>(r => loopbackService.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>(r => lanService.listen(0, lanAddress, () => r()))
    loopbackPort = (loopbackService.address() as net.AddressInfo).port
    lanPort = (lanService.address() as net.AddressInfo).port

    const config = { ...DEFAULT_CONFIG, proxy: { ...DEFAULT_CONFIG.proxy, port: PORT, bindHost: lanAddress, requireAuth: true, authToken: TOKEN } }
    proxy = new ProxyServer(config, new EventBus(config.dashboard))
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    await proxy?.stop()
    await new Promise<void>(r => loopbackService.close(() => r()))
    await new Promise<void>(r => lanService.close(() => r()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('still tunnels to an ordinary host for an authenticated remote client', async () => {
    expect(await sendConnect(lanAddress!, PORT, `${lanAddress}:${lanPort}`, auth)).toBe(200)
  })

  it.each([
    ['an IPv4 loopback literal', () => `127.0.0.1:${loopbackPort}`],
    ['a name that resolves to loopback', () => `localhost:${loopbackPort}`],
    ['the cloud metadata address', () => '169.254.169.254:80'],
    ['the unspecified address', () => `0.0.0.0:${loopbackPort}`],
    ['an IPv6 loopback literal', () => `[::1]:${loopbackPort}`],
  ])('refuses %s with 403', async (_label, target) => {
    expect(await sendConnect(lanAddress!, PORT, target(), auth)).toBe(403)
  })

  it('checks the credential before the destination', async () => {
    expect(await sendConnect(lanAddress!, PORT, `127.0.0.1:${loopbackPort}`, {})).toBe(407)
  })
})
