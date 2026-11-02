import { describe, it, expect, vi, beforeEach } from 'vitest'

let release: () => void = () => {}
let gate: Promise<void> = Promise.resolve()
const check = vi.fn(async (text: string) => {
  await gate
  // A text with this word embeds as an attack; everything else as harmless.
  return text.includes('zzattack')
    ? { similarity: 0.99, benignSimilarity: 0, nearest: 'x', chunkCount: 1 }
    : { similarity: 0, nearest: '', chunkCount: 1 }
})
vi.mock('../../src/detection/embedding.js', () => ({
  EmbeddingChecker: vi.fn().mockImplementation(function() {
    return { init: vi.fn(), check, isInitialized: vi.fn().mockReturnValue(true) }
  }),
}))

import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// An agent resends its history, and a client that times out retries. The item
// cache fills only when a scan of an item ends, so every request arriving during
// the first cold scan read the whole history again: with a slow first request and
// a few retries the firewall could fail to reach a steady state at all (#633).

const META = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }
const history = (...results: string[]) => JSON.stringify({
  model: 'm', max_tokens: 5,
  messages: [
    // Its own opening per history: a prompt two histories share is a shared item.
    { role: 'user', content: `What do these say about ${results[0]}?` },
    { role: 'assistant', content: results.map((_, i) => ({ type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} })) },
    { role: 'user', content: results.map((content, i) => ({ type: 'tool_result', tool_use_id: `t${i}`, content })) },
  ],
})
const distinctReads = () => check.mock.calls.map(c => String(c[0]))
const passes = () => check.mock.calls.length

function pipeline(overrides: Partial<typeof DEFAULT_CONFIG['detection']> = {}) {
  const c = structuredClone(DEFAULT_CONFIG)
  c.enforcement = 'enforce'
  c.detection = { ...c.detection, judgeEnabled: false, ...overrides }
  return c
}
const hold = () => { gate = new Promise(r => { release = r }) }
const settle = () => new Promise(r => setImmediate(r))

describe('concurrent scans of one history', () => {
  beforeEach(() => {
    check.mockClear()
    gate = Promise.resolve()
  })

  it('reads each item once, however many requests carry it at the same time', async () => {
    const body = history('first result of the build', 'second result of the build', 'third result of the build')
    const alone = new Pipeline(pipeline())
    await alone.run('/v1/messages', body, META)
    const onePass = passes()
    expect(onePass).toBeGreaterThan(0)

    check.mockClear()
    hold()
    const p = new Pipeline(pipeline())
    const runs = [p.run('/v1/messages', body, META), p.run('/v1/messages', body, META), p.run('/v1/messages', body, META)]
    await settle()
    release()
    const results = await Promise.all(runs)
    expect(results.map(r => r.action)).toEqual(['pass', 'pass', 'pass'])
    expect(passes()).toBe(onePass)
  })

  it('a retry that arrives during the first scan shares it', async () => {
    const body = history('a long result the first request is still reading')
    hold()
    const p = new Pipeline(pipeline())
    const first = p.run('/v1/messages', body, META)
    await settle()
    const before = passes()
    const retry = p.run('/v1/messages', body, META)
    await settle()
    expect(passes()).toBe(before)
    release()
    await Promise.all([first, retry])
  })

  it('every request gets a verdict of its own when one blocks: an attack is never shared away', async () => {
    const body = history('a zzattack result')
    hold()
    const events: unknown[] = []
    const c = pipeline()
    c.detection.surfaces = { ...c.detection.surfaces, tool_result: { ...c.detection.surfaces?.tool_result, onBlock: 'refuse', embeddingMarginThreshold: 0 } }
    const p = new Pipeline(c, (e => { events.push(e); return e as never }) as never)
    const runs = [p.run('/v1/messages', body, META), p.run('/v1/messages', body, META)]
    await settle()
    release()
    const results = await Promise.all(runs)
    expect(results.map(r => r.action)).toEqual(['block', 'block'])
    // Each refused request is reported: its client is quoted that event.
    expect(events).toHaveLength(2)
  })

  it('a scan that throws does not hang the requests waiting on it', async () => {
    const body = history('a result whose scan fails')
    hold()
    const p = new Pipeline(pipeline())
    check.mockImplementationOnce(async () => { await gate; throw new Error('model failed') })
    const runs = [p.run('/v1/messages', body, META).then(r => r.action, () => 'threw'), p.run('/v1/messages', body, META).then(r => r.action, () => 'threw')]
    await settle()
    release()
    const results = await Promise.race([Promise.all(runs), new Promise(r => setTimeout(() => r('hung'), 2000))])
    expect(results).not.toBe('hung')
    expect(results).toContain('threw')
  })

  it('a waiter reads the item itself when the scan it shared was cut by the budget', async () => {
    const body = JSON.stringify({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'a prompt the budget cuts short' }] })
    hold()
    const p = new Pipeline(pipeline())
    check.mockImplementationOnce(async () => { await gate; return { similarity: 0, nearest: '', chunkCount: 0, budgetExhausted: true } as never })
    const runs = [p.run('/v1/messages', body, META), p.run('/v1/messages', body, META)]
    await settle()
    expect(passes()).toBe(1)
    release()
    await Promise.all(runs)
    // The second request has an answer only by reading it: the first read part.
    expect(passes()).toBe(2)
  })

  it('a different text is not made to wait', async () => {
    hold()
    const p = new Pipeline(pipeline())
    const a = p.run('/v1/messages', history('one text'), META)
    await settle()
    const before = distinctReads().length
    const b = p.run('/v1/messages', history('quite another text'), META)
    await settle()
    expect(distinctReads().length).toBeGreaterThan(before)
    release()
    await Promise.all([a, b])
  })

  it('a text waiting on another client gets its warn too', async () => {
    const body = history('a result of the build')
    hold()
    const c = pipeline()
    const p = new Pipeline(c)
    check.mockImplementationOnce(async () => {
      await gate
      return { similarity: c.detection.embeddingWarnThreshold + 0.001, benignSimilarity: 0, nearest: 'x', chunkCount: 1 }
    })
    const runs = [p.run('/v1/messages', body, META), p.run('/v1/messages', body, META)]
    await settle()
    release()
    const results = await Promise.all(runs)
    expect(results.map(r => r.action)).toEqual(results.map(() => results[0]!.action))
  })
})
