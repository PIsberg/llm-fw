import { describe, it, expect, vi, beforeEach } from 'vitest'

// detection.classifier.requireCorroboration: the classifier blocks only when
// a cheap stage saw something too. Replayed from real transcripts, 2026-10-31:
// 223 of 251 blocks under a config with the classifier on came from the
// classifier alone, among them typed prompts such as "merge 207 and switch
// back to main" (95.6%). The real classifier stage runs over a fake model;
// the heuristic and embedding stages are mocked so each case decides what
// they see, as in pipeline-claude-code.test.ts.
const fakeClassify = vi.fn()
vi.mock('@huggingface/transformers', () => ({ env: {}, pipeline: vi.fn(async () => fakeClassify) }))
vi.mock('../../src/detection/heuristic.js', () => ({ HeuristicScorer: vi.fn() }))
vi.mock('../../src/detection/embedding.js', () => ({ EmbeddingChecker: vi.fn() }))
vi.mock('../../src/detection/judge.js', () => ({ JudgeClient: vi.fn() }))

import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { HeuristicScorer } from '../../src/detection/heuristic.js'
import { EmbeddingChecker } from '../../src/detection/embedding.js'
import { JudgeClient } from '../../src/detection/judge.js'
import type { BlockEvent } from '../../src/types.js'

type MockFn = ReturnType<typeof vi.fn>

// The fake model flags any text holding FLAG. "weak" scores 30 on the
// heuristic (suspicious, under the 50 block threshold); "near" sits at 0.83
// on the embedding (over the 0.80 warn threshold, under the 0.86 block one).
beforeEach(() => {
  const score = vi.fn((t: string) => t.includes('weak') ? { score: 30, matches: ['soft-signal'] } : { score: 0, matches: [] })
  ;(HeuristicScorer as unknown as MockFn).mockImplementation(function() { return { score, scoreRules: score } })
  ;(EmbeddingChecker as unknown as MockFn).mockImplementation(function() {
    return {
      init: vi.fn(),
      check: vi.fn(async (t: string) => t.includes('near') ? { similarity: 0.83, benignSimilarity: 0.7, nearest: 'anchor', chunkCount: 1 } : { similarity: 0, nearest: '', chunkCount: 1 }),
      isInitialized: vi.fn().mockReturnValue(true),
    }
  })
  ;(JudgeClient as unknown as MockFn).mockImplementation(function() {
    return { classify: vi.fn().mockResolvedValue({ verdict: 'SAFE', latencyMs: 1 }), judgeRagContext: vi.fn().mockResolvedValue({ verdict: 'SAFE', latencyMs: 1 }) }
  })
  fakeClassify.mockReset()
  fakeClassify.mockImplementation(async (t: string) => t.includes('FLAG') ? [{ label: 'INJECTION', score: 0.99 }] : [{ label: 'SAFE', score: 0.99 }])
})

function config(requireCorroboration: boolean | undefined) {
  const c = structuredClone(DEFAULT_CONFIG)
  c.detection.classifier = { ...c.detection.classifier, enabled: true, blockThreshold: 0.9 }
  if (requireCorroboration === undefined) delete (c.detection.classifier as { requireCorroboration?: boolean }).requireCorroboration
  else c.detection.classifier.requireCorroboration = requireCorroboration
  return c
}

const META = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }
const prompt = (text: string) => JSON.stringify({ model: 'claude-x', messages: [{ role: 'user', content: [{ type: 'text', text }] }] })
const toolResult = (text: string) => JSON.stringify({
  model: 'claude-x',
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'read it' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] },
  ],
})

async function run(requireCorroboration: boolean | undefined, body: string) {
  const events: Omit<BlockEvent, 'id' | 'timestamp'>[] = []
  const p = new Pipeline(config(requireCorroboration), e => { events.push(e) })
  await p.init()
  const r = await p.run('/v1/messages', body, META)
  return { r, events }
}

describe('classifier corroboration', () => {
  it('warns instead of blocking when only the classifier saw anything', async () => {
    const { r, events } = await run(true, prompt('merge FLAG and switch back to main'))
    expect(r.action).toBe('warn')
    expect(r.stage).toBe('classifier')
    expect(events.map(e => e.payload_preview)).toEqual([expect.stringMatching(/^\[classifier: injection 99\.0% — uncorroborated\]/)])
    // The warn keeps the text the classifier scored, so it can be read and
    // marked as a false positive like any other event.
    expect(events[0]!.payload_full).toBe('merge FLAG and switch back to main')
    expect(events[0]!.suppressionKey).toBeDefined()
  })

  it('blocks when the heuristic stage found a suspicious signal on the same text', async () => {
    const { r } = await run(true, prompt('FLAG weak wording'))
    expect(r.action).toBe('block')
    expect(r.stage).toBe('classifier')
  })

  it('blocks when the embedding stage put the same text over its warn threshold', async () => {
    const { r } = await run(true, prompt('FLAG near an anchor'))
    expect(r.action).toBe('block')
    expect(r.stage).toBe('classifier')
  })

  it('applies to tool results too', async () => {
    expect((await run(true, toolResult('FLAG output'))).r.action).toBe('warn')
    expect((await run(true, toolResult('FLAG weak output'))).r.action).toBe('block')
  })

  it('blocks on the classifier alone when corroboration is off', async () => {
    expect((await run(false, prompt('merge FLAG and switch back to main'))).r.action).toBe('block')
  })

  it('leaves a text the classifier passes alone', async () => {
    expect((await run(true, prompt('merge 207 and switch back to main'))).r.action).toBe('pass')
  })
})
