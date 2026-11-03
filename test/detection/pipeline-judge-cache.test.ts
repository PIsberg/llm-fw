import { describe, it, expect, vi, beforeEach } from 'vitest'

const check = vi.fn(async () => ({ similarity: 0, nearest: '', chunkCount: 1 }))
const classify = vi.fn()
const judgeRagContext = vi.fn()
const classifierScore = vi.fn()
vi.mock('../../src/detection/embedding.js', () => ({
  EmbeddingChecker: vi.fn().mockImplementation(function() {
    return { init: vi.fn(), check, isInitialized: vi.fn().mockReturnValue(true) }
  }),
}))
vi.mock('../../src/detection/classifier.js', () => ({
  InjectionClassifier: vi.fn().mockImplementation(function() {
    return { init: vi.fn(), classify: classifierScore, isInitialized: vi.fn().mockReturnValue(true) }
  }),
}))
vi.mock('../../src/detection/judge.js', () => ({
  JudgeClient: vi.fn().mockImplementation(function() {
    return { classify, judgeRagContext }
  }),
}))

import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// With the judge on the item cache was off, so every resend rescanned the whole
// history: about 830 ms against 5 ms on one 120-item history, on the thread that
// serves every request (#656). It was off so that a failed judge call would not
// be remembered as clean. Only a call that could decide the verdict needs that.

const META = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }
// Long enough that judgeUnlessBenign sends it to the judge with no other signal.
const TEXT = 'Please summarize the release notes for the parser and list what changed in the retry loop since the last version.'
const prompt = (text: string) => JSON.stringify({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: text }] })

function pipeline(detection: Partial<typeof DEFAULT_CONFIG['detection']>, onBlock?: (e: unknown) => unknown) {
  const c = structuredClone(DEFAULT_CONFIG)
  c.enforcement = 'enforce'
  c.detection = { ...c.detection, judgeEnabled: true, judgeUnlessBenign: true, ...detection }
  return new Pipeline(c, onBlock as never)
}
const SAFE = { verdict: 'SAFE', latencyMs: 1 }
const ERROR = { verdict: 'ERROR', latencyMs: 1 }
const MALICIOUS = { verdict: 'MALICIOUS', latencyMs: 1 }

describe('the item cache with the judge on', () => {
  beforeEach(() => {
    check.mockClear()
    classify.mockReset()
    judgeRagContext.mockReset()
    classify.mockResolvedValue(SAFE)
    judgeRagContext.mockResolvedValue(SAFE)
    classifierScore.mockReset()
    classifierScore.mockResolvedValue(null)
  })

  it('a resend does not rescan, with the judge monitoring asynchronously', async () => {
    const p = pipeline({ judgeBlock: false })
    await p.run('/v1/messages', prompt(TEXT), META)
    const reads = check.mock.calls.length
    const asked = classify.mock.calls.length
    expect(reads).toBeGreaterThan(0)
    expect(asked).toBeGreaterThan(0)

    await p.run('/v1/messages', prompt(TEXT), META)
    expect(check.mock.calls.length).toBe(reads)
    expect(classify.mock.calls.length).toBe(asked)
  })

  it('a resend does not rescan after the blocking judge said safe', async () => {
    const p = pipeline({ judgeBlock: true })
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
    const asked = classify.mock.calls.length
    expect(asked).toBeGreaterThan(0)
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
    expect(classify.mock.calls.length).toBe(asked)
  })

  // The reason the cache was off, and it must keep holding.
  describe('a failed judge is asked again, never remembered as clean', () => {
    it('the blocking judge: an attack the judge could not read on the first turn is refused on the next', async () => {
      classify.mockResolvedValue(ERROR)
      const p = pipeline({ judgeBlock: true })
      expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
      classify.mockResolvedValue(MALICIOUS)
      expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('block')
    })

    it('the entropy route', async () => {
      const dense = Array.from({ length: 300 }, (_, i) => String.fromCharCode(33 + ((i * 37) % 90))).join('')
      classify.mockResolvedValue(ERROR)
      const p = pipeline({ judgeBlock: false })
      expect((await p.run('/v1/messages', prompt(dense), META)).action).toBe('pass')
      classify.mockResolvedValue(MALICIOUS)
      expect((await p.run('/v1/messages', prompt(dense), META)).action).toBe('block')
    })

    it('the classifier gray zone', async () => {
      classifierScore.mockResolvedValue({ score: 0.7, injection: false })
      classify.mockResolvedValue(ERROR)
      const c = structuredClone(DEFAULT_CONFIG)
      c.enforcement = 'enforce'
      c.detection = { ...c.detection, judgeEnabled: true, judgeBlock: false, classifier: { ...c.detection.classifier!, enabled: true, escalateThreshold: 0.5, blockThreshold: 0.99 } }
      const p = new Pipeline(c)
      expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
      classify.mockResolvedValue(MALICIOUS)
      const second = await p.run('/v1/messages', prompt(TEXT), META)
      expect(second.action).toBe('block')
      expect(second.stage).toBe('judge')
    })

    it('the RAG judge', async () => {
      const rag = '<document>The parser reads the configuration and returns a value to the caller.</document> Summarize that.'
      judgeRagContext.mockResolvedValue(ERROR)
      const c = structuredClone(DEFAULT_CONFIG)
      c.enforcement = 'enforce'
      c.detection = { ...c.detection, judgeEnabled: true, judgeBlock: false }
      c.rag = { ...c.rag, enabled: true }
      const p = new Pipeline(c)
      expect((await p.run('/v1/messages', prompt(rag), META)).action).toBe('pass')
      judgeRagContext.mockResolvedValue(MALICIOUS)
      expect((await p.run('/v1/messages', prompt(rag), META)).action).toBe('block')
    })
  })

  it('a block is not remembered: it blocks and is reported on every send', async () => {
    classify.mockResolvedValue(MALICIOUS)
    const events: unknown[] = []
    const p = pipeline({ judgeBlock: true }, e => { events.push(e); return e })
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('block')
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('block')
    expect(events).toHaveLength(2)
  })

  it('a warn from the asynchronous judge is reported, and once, not on every resend', async () => {
    classify.mockResolvedValue(MALICIOUS)
    const events: Record<string, unknown>[] = []
    const p = pipeline({ judgeBlock: false }, e => { events.push(e as Record<string, unknown>); return e })
    await p.run('/v1/messages', prompt(TEXT), META)
    await new Promise(r => setImmediate(r))
    const first = events.filter(e => e.verdict === 'MALICIOUS').length
    expect(first).toBeGreaterThan(0)
    await p.run('/v1/messages', prompt(TEXT), META)
    await new Promise(r => setImmediate(r))
    expect(events.filter(e => e.verdict === 'MALICIOUS').length).toBe(first)
  })

  it('never lets the asynchronous judge change a verdict', async () => {
    classify.mockResolvedValue(MALICIOUS)
    const p = pipeline({ judgeBlock: false })
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
    expect((await p.run('/v1/messages', prompt(TEXT), META)).action).toBe('pass')
  })
})
