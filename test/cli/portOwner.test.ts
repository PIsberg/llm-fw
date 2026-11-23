import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import { freeLlmFwPort, listeningPids, answersAsLlmFw, waitForPortFree } from '../../src/cli/portOwner.js'

// #863: `llm-fw start` killed whatever listened on the proxy or dashboard
// port, an unrelated dev server included. It now stops an owner only when
// the port answers as llm-fw does, and otherwise refuses and says why.
describe('freeLlmFwPort', () => {
  const unix = (pids: string) => ({
    os: 'linux' as NodeJS.Platform,
    run: vi.fn((file: string) => { if (file !== 'lsof') throw new Error('unexpected ' + file); return pids }),
    kill: vi.fn(),
    selfPid: 999,
  })

  it('stops the owner of a port that answers as llm-fw, never itself', async () => {
    const deps = { ...unix('123\n999\n'), probe: vi.fn(async () => true) }
    const r = await freeLlmFwPort(8080, deps)
    expect(r).toEqual({ owners: [123], stopped: true })
    expect(deps.kill.mock.calls).toEqual([[123]])
  })

  it('leaves the owner of a port that does not answer as llm-fw alone', async () => {
    const deps = { ...unix('4242\n'), probe: vi.fn(async () => false) }
    const r = await freeLlmFwPort(8080, deps)
    expect(r).toEqual({ owners: [4242], stopped: false })
    expect(deps.kill).not.toHaveBeenCalled()
  })

  it('reads the owner from netstat on Windows', () => {
    const out = [
      '  TCP    0.0.0.0:7731           0.0.0.0:0              LISTENING       5150',
      '  TCP    127.0.0.1:8080         0.0.0.0:0              LISTENING       6160',
      '  TCP    127.0.0.1:18080        0.0.0.0:0              LISTENING       7170',
      '  TCP    127.0.0.1:8080         127.0.0.1:50000        ESTABLISHED     8180',
    ].join('\r\n')
    expect(listeningPids(8080, { os: 'win32', run: () => out, selfPid: 1 })).toEqual([6160])
  })
})

describe('answersAsLlmFw', () => {
  const serve = (status: number, body: string) => new Promise<http.Server>(resolve => {
    const s = http.createServer((_req, res) => { res.writeHead(status); res.end(body) })
    s.listen(0, '127.0.0.1', () => resolve(s))
  })
  const port = (s: http.Server) => (s.address() as { port: number }).port

  it("recognises the proxy's plain-HTTP refusal and the dashboard page", async () => {
    const proxy = await serve(501, JSON.stringify({ error: 'plain HTTP proxying is not supported', detail: 'llm-fw intercepts HTTPS via CONNECT.' }))
    const dash = await serve(200, '<!DOCTYPE html><title>llm-fw</title>')
    try {
      expect(await answersAsLlmFw(port(proxy))).toBe(true)
      expect(await answersAsLlmFw(port(dash))).toBe(true)
    } finally { proxy.close(); dash.close() }
  })

  it('does not recognise anything else, or nothing at all', async () => {
    const other = await serve(200, '<!DOCTYPE html><title>Vite dev server</title>')
    try {
      expect(await answersAsLlmFw(port(other))).toBe(false)
    } finally { other.close() }
    const dead = await serve(200, '')
    const p = port(dead)
    await new Promise<void>(resolve => dead.close(() => resolve()))
    expect(await answersAsLlmFw(p)).toBe(false)
  })
})

// #863, found live: the check bound the port on every interface, which on
// Windows succeeds while another program holds 127.0.0.1:<port>. `start`
// then took the port for free and died on EADDRINUSE when the proxy bound.
describe('waitForPortFree', () => {
  it('sees a port held on the host llm-fw binds as taken', async () => {
    const holder = await new Promise<http.Server>(resolve => {
      const s = http.createServer()
      s.listen(0, '127.0.0.1', () => resolve(s))
    })
    const port = (holder.address() as { port: number }).port
    try {
      expect(await waitForPortFree(port, '127.0.0.1', 300)).toBe(false)
    } finally {
      await new Promise<void>(resolve => holder.close(() => resolve()))
    }
    expect(await waitForPortFree(port, '127.0.0.1', 300)).toBe(true)
  })
})
