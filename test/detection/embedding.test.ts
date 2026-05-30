import { describe, it, expect, vi, beforeEach } from 'vitest'

const DIM = 4

function makeFakeBatchOutput(n: number): { data: Float32Array; dims: number[] } {
  const data = new Float32Array(n * DIM)
  for (let i = 0; i < n; i++) data[i * DIM + (i % DIM)] = 1
  return { data, dims: [n, DIM] }
}

function makeFakeSingleOutput(vec: number[]): { data: Float32Array } {
  return { data: Float32Array.from(vec) }
}

// Use vi.hoisted so mockExtractor is available at mock factory time
const { mockExtractor } = vi.hoisted(() => ({ mockExtractor: vi.fn() }))

vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn().mockResolvedValue(mockExtractor),
  env: { cacheDir: '', allowLocalModels: false },
}))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: vi.fn((path: string, enc: string) => {
      if (String(path).endsWith('attacks.json')) {
        return JSON.stringify(['attack one', 'attack two', 'attack three'])
      }
      return actual.readFileSync(path, enc as any)
    }),
  }
})

import { EmbeddingChecker } from '../../src/detection/embedding.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

describe('EmbeddingChecker — simplified cosine similarity (FIX-7)', () => {
  it('FIX-7: identical unit vectors have similarity 1.0', () => {
    // Access the private method via casting
    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    const sim = (checker as any).cosineSimilarity as (a: Float32Array, b: Float32Array) => number

    const v = Float32Array.from([0.6, 0.8]) // already unit: sqrt(0.36+0.64)=1
    expect(sim.call(checker, v, v)).toBeCloseTo(1.0, 5)
  })

  it('FIX-7: orthogonal unit vectors have similarity 0', () => {
    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    const sim = (checker as any).cosineSimilarity as (a: Float32Array, b: Float32Array) => number

    const a = Float32Array.from([1, 0])
    const b = Float32Array.from([0, 1])
    expect(sim.call(checker, a, b)).toBeCloseTo(0, 5)
  })

  it('FIX-7: similarity is clamped to [0, 1] even with floating-point overshoot', () => {
    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    const sim = (checker as any).cosineSimilarity as (a: Float32Array, b: Float32Array) => number

    // Floating-point can produce dot > 1 for near-identical vectors; clamp must handle it
    const v = Float32Array.from([1, 0])
    const result = sim.call(checker, v, v)
    expect(result).toBeLessThanOrEqual(1)
    expect(result).toBeGreaterThanOrEqual(0)
  })
})

describe('EmbeddingChecker — batch init (FIX-4)', () => {
  beforeEach(() => {
    mockExtractor.mockReset()
  })

  it('FIX-4: init() calls extractor ONCE with all attacks as a batch array', async () => {
    mockExtractor
      .mockResolvedValueOnce(makeFakeBatchOutput(3))
      .mockResolvedValue(makeFakeSingleOutput([1, 0, 0, 0]))

    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    await checker.init()

    expect(mockExtractor).toHaveBeenCalledOnce()
    const [firstArg] = mockExtractor.mock.calls[0]
    expect(Array.isArray(firstArg)).toBe(true)
    expect(firstArg).toHaveLength(3)
    expect(firstArg[0]).toBe('attack one')
  })

  it('loads all 3 templates from the single batch result', async () => {
    mockExtractor
      .mockResolvedValueOnce(makeFakeBatchOutput(3))
      .mockResolvedValue(makeFakeSingleOutput([1, 0, 0, 0]))

    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    await checker.init()

    expect(checker.isInitialized()).toBe(true)
    expect((checker as any).templateEmbeddings).toHaveLength(3)
    expect((checker as any).templateStrings).toEqual(['attack one', 'attack two', 'attack three'])
  })

  it('check() works correctly after batched init', async () => {
    mockExtractor
      .mockResolvedValueOnce(makeFakeBatchOutput(3))
      .mockResolvedValue(makeFakeSingleOutput([1, 0, 0, 0])) // matches row 0 exactly

    const checker = new EmbeddingChecker(DEFAULT_CONFIG.detection)
    await checker.init()

    const result = await checker.check('some input text')
    expect(result.similarity).toBeGreaterThan(0)
    expect(result.chunkCount).toBeGreaterThanOrEqual(1)
    expect(typeof result.nearest).toBe('string')
  })
})
