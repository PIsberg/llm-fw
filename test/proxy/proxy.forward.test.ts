import { describe, it, expect, vi, beforeEach } from 'vitest'
import https from 'node:https'

// Mock heavy dependencies so we don't need a real CA or model
vi.mock('../../src/proxy/certs.js', () => ({
  CertFactory: vi.fn().mockImplementation(() => ({
    getHostCert: vi.fn().mockReturnValue({ cert: 'cert', key: 'key' }),
    warmHostKey: vi.fn(),
  })),
}))
vi.mock('../../src/proxy/upstream.js', () => ({
  UpstreamResolver: vi.fn().mockImplementation(() => ({
    resolve: vi.fn().mockResolvedValue('1.2.3.4'),
  })),
}))
vi.mock('../../src/detection/pipeline.js', () => ({
  Pipeline: vi.fn().mockImplementation(() => ({
    init: vi.fn().mockResolvedValue(undefined),
    run: vi.fn().mockResolvedValue({ action: 'pass', stage: 'none', score: 0, similarity: 0 }),
  })),
}))
vi.mock('../../src/dashboard/eventBus.js', () => ({
  EventBus: vi.fn().mockImplementation(() => ({ emit: vi.fn() })),
}))

import { ProxyServer } from '../../src/proxy/proxy.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { EventBus } from '../../src/dashboard/eventBus.js'

describe('ProxyServer.forwardRequest — FIX-3: https.request with Keep-Alive', () => {
  it('FIX-3: agent has keepAlive enabled', () => {
    const config = { ...DEFAULT_CONFIG }
    const eventBus = new EventBus(config.dashboard)
    const proxy = new ProxyServer(config, eventBus)
    const agent = (proxy as any).agent as https.Agent
    expect(agent).toBeInstanceOf(https.Agent)
    expect(agent.keepAlive).toBe(true)
  })

  it('FIX-3: forwardRequest calls https.request (not tls.connect)', async () => {
    const requestSpy = vi.spyOn(https, 'request')

    // Build a fake IncomingMessage-like object
    const fakeReq = {
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json', host: 'api.anthropic.com' },
    }

    // Build a fake ServerResponse that records written data
    const written: any[] = []
    const fakeRes = {
      headersSent: false,
      writeHead: vi.fn(),
      write: vi.fn((d: any) => written.push(d)),
      end: vi.fn(),
    }

    // Mock https.request to return a fake response immediately
    requestSpy.mockImplementationOnce((_opts: any, callback: any) => {
      const fakeUpstream = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        pipe: vi.fn((dest: any) => {
          dest.end()
          return dest
        }),
        on: vi.fn((event: string, cb: any) => {
          if (event === 'end') cb()
          return fakeUpstream
        }),
      }
      callback(fakeUpstream)
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn(),
        end: vi.fn(),
      } as any
    })

    const config = { ...DEFAULT_CONFIG }
    const eventBus = new EventBus(config.dashboard)
    const proxy = new ProxyServer(config, eventBus)

    await (proxy as any).forwardRequest('api.anthropic.com', 443, fakeReq, '{"test":1}', fakeRes)

    expect(requestSpy).toHaveBeenCalledOnce()
    const callOpts = requestSpy.mock.calls[0][0] as any
    // Correct hostname override (resolved IP)
    expect(callOpts.hostname).toBe('1.2.3.4')
    // SNI servername preserved
    expect(callOpts.servername).toBe('api.anthropic.com')
    // Host header set to original hostname, not IP
    expect(callOpts.headers.host).toBe('api.anthropic.com')
    // Agent passed (enables Keep-Alive)
    expect(callOpts.agent).toBeInstanceOf(https.Agent)

    requestSpy.mockRestore()
  })
})
