import { describe, it, expect, vi } from 'vitest'
import type http from 'node:http'
import { stripUsageChunk } from '../../src/modules/sseUsageStrip.js'
import { LeanCtxModule } from '../../src/modules/builtin/leanCtx.js'
import { ResponseCacheModule } from '../../src/modules/builtin/responseCache.js'

// #871: buffers the modules held without a bound.
function fakeRes() {
  const written: string[] = []
  const res = {
    headers: {} as Record<string, unknown>,
    writeHead(_s: number, h?: Record<string, unknown>) { Object.assign(this.headers, h ?? {}); return this },
    write: vi.fn((chunk: unknown) => { written.push(String(chunk)); return true }),
    end: vi.fn((chunk?: unknown) => { if (chunk) written.push(String(chunk)); return this }),
    getHeader(k: string) { return this.headers[k] },
    removeHeader(k: string) { delete this.headers[k] },
  }
  return { res: res as unknown as http.ServerResponse, written }
}

describe('stripUsageChunk holds at most 1 MiB waiting for an event end (#871)', () => {
  it('passes a stream with no blank lines through instead of holding it', () => {
    const { res, written } = fakeRes()
    stripUsageChunk(res)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const piece = 'data: ' + 'x'.repeat(256 * 1024)
    for (let i = 0; i < 8; i++) res.write(piece)
    // 2 MiB in, none of it an event end: what is past the bound went out.
    expect(written.join('').length).toBeGreaterThanOrEqual(1024 * 1024)
  })

  it('still drops a usage-only chunk from an ordinary stream', () => {
    const { res, written } = fakeRes()
    stripUsageChunk(res)
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n')
    res.write('data: {"choices":[],"usage":{"prompt_tokens":3}}\n\n')
    res.end('data: [DONE]\n\n')
    expect(written.join('')).not.toContain('"usage"')
    expect(written.join('')).toContain('[DONE]')
  })
})

describe('module stores have a byte budget (#871)', () => {
  it('LeanCtxModule keeps at most 64 MiB of remembered outputs', () => {
    const mod = new LeanCtxModule({ enabled: true } as never)
    const remember = (mod as unknown as { remember(key: string, out: string | null): void }).remember.bind(mod)
    const big = 'y'.repeat(1024 * 1024)
    for (let i = 0; i < 200; i++) remember(`k${i}`, big)
    expect(mod.rememberedBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)
  })

  it('ResponseCacheModule keeps at most 64 MiB of responses', () => {
    const cache = new ResponseCacheModule({ enabled: true, ttlSeconds: 300, maxEntries: 1000, maxEntryBytes: 2 * 1024 * 1024 })
    const ctx = { target: 'api.openai.com', method: 'POST', path: '/v1/chat/completions', headers: { authorization: 'Bearer k' } } as never
    const body = Buffer.alloc(1024 * 1024, 0x61)
    for (let i = 0; i < 200; i++) cache.observeResponse(`{"n":${i}}`, ctx, { status: 200, headers: { 'content-type': 'application/json' }, body })
    expect(cache.heldBytes()).toBeLessThanOrEqual(64 * 1024 * 1024)
  })
})
