import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/detection/heuristic.js', () => ({ HeuristicScorer: vi.fn() }))
vi.mock('../../src/detection/embedding.js', () => ({ EmbeddingChecker: vi.fn() }))
vi.mock('../../src/detection/judge.js', () => ({ JudgeClient: vi.fn() }))
vi.mock('../../src/detection/classifier.js', () => ({ InjectionClassifier: vi.fn() }))

import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { HeuristicScorer } from '../../src/detection/heuristic.js'
import { EmbeddingChecker } from '../../src/detection/embedding.js'
import { JudgeClient } from '../../src/detection/judge.js'
import { InjectionClassifier } from '../../src/detection/classifier.js'
import type { Config } from '../../src/types.js'

type MockFn = ReturnType<typeof vi.fn>

// Two weak signals on one text (#533). The stages are stubbed so each case
// states the numbers it is about: the heuristic score, the similarity to the
// nearest attack anchor and to the nearest benign one.
let signals = { score: 0, similarity: 0, benignSimilarity: 0 }

beforeEach(() => {
  const score = vi.fn(() => ({ score: signals.score, matches: signals.score ? ['unconstrained-persona'] : [] }))
  ;(HeuristicScorer as unknown as MockFn).mockImplementation(function () { return { score, scoreRules: score } })
  ;(EmbeddingChecker as unknown as MockFn).mockImplementation(function () {
    return {
      init: vi.fn(),
      isInitialized: vi.fn().mockReturnValue(true),
      check: vi.fn(async () => ({ similarity: signals.similarity, benignSimilarity: signals.benignSimilarity, nearest: 'anchor', chunkCount: 1 })),
    }
  })
  ;(JudgeClient as unknown as MockFn).mockImplementation(function () {
    return { classify: vi.fn().mockResolvedValue({ verdict: 'SAFE', latencyMs: 1 }), judgeRagContext: vi.fn().mockResolvedValue({ verdict: 'SAFE', latencyMs: 1 }) }
  })
  ;(InjectionClassifier as unknown as MockFn).mockImplementation(function () {
    return { init: vi.fn(), classify: vi.fn().mockResolvedValue(null), isInitialized: vi.fn().mockReturnValue(false) }
  })
})

const META = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }
const TEXT = 'A request that is neither clearly an attack nor clearly ordinary.'

async function run(s: typeof signals, tweak?: (c: Config) => void, body?: string) {
  signals = s
  const config = structuredClone(DEFAULT_CONFIG)
  config.detection.judgeEnabled = false
  tweak?.(config)
  const pipeline = new Pipeline(config)
  await pipeline.init()
  return pipeline.run('/v1/messages', body ?? JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: TEXT }] }), META)
}

describe('two weak signals on the same text', () => {
  it('blocks when a rule scored 30 and the embedding stage would warn about the same text', async () => {
    const r = await run({ score: 30, similarity: 0.82, benignSimilarity: 0.79 })
    expect(r.action).toBe('block')
    expect(r.stage).toBe('embedding')
    expect(r.score).toBe(30)
    expect(r.similarity).toBeCloseTo(0.82)
    // The refusal names the rule as well as the anchor: both decided it.
    expect(r.heuristicMatches).toEqual(['unconstrained-persona'])
  })

  it('does not block on either signal alone', async () => {
    expect((await run({ score: 30, similarity: 0.5, benignSimilarity: 0.4 })).action).not.toBe('block')
    expect((await run({ score: 0, similarity: 0.85, benignSimilarity: 0.75 })).action).not.toBe('block')
  })

  it('does not block below either line: a score of 20, or a similarity under the warn threshold', async () => {
    expect((await run({ score: 20, similarity: 0.85, benignSimilarity: 0.75 })).action).not.toBe('block')
    expect((await run({ score: 40, similarity: 0.79, benignSimilarity: 0.70 })).action).not.toBe('block')
  })

  it('does not block text that is not clearly closer to an attack anchor than to a benign one', async () => {
    expect((await run({ score: 40, similarity: 0.84, benignSimilarity: 0.85 })).action).not.toBe('block')
    // The margin the embedding stage itself asks for (0.02), not a looser
    // one: a skill's instruction file in real traffic sat at 0.006.
    expect((await run({ score: 30, similarity: 0.838, benignSimilarity: 0.832 })).action).not.toBe('block')
  })

  it("measures the margin even for text that names the model's instructions", async () => {
    // The embedding stage skips the benign subtraction for such text and
    // judges it on similarity alone. Here that would make the second signal
    // free: a security-review prompt and source files that discuss prompts
    // blocked that way in a replay of real traffic.
    const text = 'Review your instructions for the release and list what changed since the last one.'
    const body = JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: text }] })
    expect((await run({ score: 35, similarity: 0.82, benignSimilarity: 0.815 }, undefined, body)).action).not.toBe('block')
    expect((await run({ score: 35, similarity: 0.82, benignSimilarity: 0.75 }, undefined, body)).action).toBe('block')
  })

  it('takes the margin a surface sets for itself', async () => {
    const toolResult = JSON.stringify({ model: 'm', max_tokens: 1, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: TEXT }] }] })
    const loose = await run({ score: 30, similarity: 0.838, benignSimilarity: 0.832 }, c => {
      c.detection.surfaces = { ...c.detection.surfaces, tool_result: { ...c.detection.surfaces?.tool_result, onBlock: 'refuse', embeddingMarginThreshold: 0 } }
    }, toolResult)
    expect(loose.action).toBe('block')
  })

  it('is switched off by detection.combinedBlockScore: 0', async () => {
    const r = await run({ score: 40, similarity: 0.84, benignSimilarity: 0.75 }, c => { c.detection.combinedBlockScore = 0 })
    expect(r.action).not.toBe('block')
  })

  it('moves with detection.combinedBlockScore and detection.embeddingWarnThreshold', async () => {
    expect((await run({ score: 30, similarity: 0.82, benignSimilarity: 0.75 }, c => { c.detection.combinedBlockScore = 40 })).action).not.toBe('block')
    expect((await run({ score: 30, similarity: 0.82, benignSimilarity: 0.75 }, c => { c.detection.embeddingWarnThreshold = 0.83 })).action).not.toBe('block')
  })

  it('is a wording block: demoted to a warning where the operator demotes those', async () => {
    const r = await run({ score: 30, similarity: 0.82, benignSimilarity: 0.75 }, c => {
      c.detection.surfaces = { ...c.detection.surfaces, prompt: { ...c.detection.surfaces?.prompt, wordingAction: 'warn' } }
    })
    expect(r.action).toBe('warn')
  })

  it('leaves the two stages their own blocks', async () => {
    expect((await run({ score: 50, similarity: 0, benignSimilarity: 0 })).stage).toBe('heuristic')
    const e = await run({ score: 0, similarity: 0.9, benignSimilarity: 0.5 })
    expect(e.action).toBe('block')
    expect(e.heuristicMatches).toBeUndefined()
  })
})
