import { describe, it, expect, vi } from 'vitest'
import { readWhole, MODEL_MAX_TOKENS } from '../../src/detection/readWhole.js'
import type { ClassifyFn } from '../../src/detection/classifier.js'

/**
 * #951: the classifiers lay their windows out by an estimate of the
 * tokenizer's count, which undercounts non-English text written in plain
 * ASCII letters (Aya: 74 of 2,955 windows over 512 real tokens, up to 826),
 * and the model reads only the first 512. readWhole checks a window with the
 * model's own tokenizer and reads one that runs over in pieces that fit.
 */

// A tokenizer that counts one token per two characters, shaped like
// transformers.js's: input_ids with dims [1, n].
const tokenizer = (text: string) => ({ input_ids: { dims: [1, Math.ceil(text.length / 2)] } })
const PAYLOAD = 'PAYLOAD'

function fakeClassifier() {
  const seen: string[] = []
  const fn = vi.fn(async (text: string) => {
    seen.push(text)
    return [text.includes(PAYLOAD) ? { label: 'INJECTION', score: 0.99 } : { label: 'SAFE', score: 0.9 }]
  }) as unknown as ClassifyFn & { tokenizer: typeof tokenizer }
  ;(fn as unknown as { tokenizer: typeof tokenizer }).tokenizer = tokenizer
  return { fn, seen }
}
const injectionScore = (out: { label: string; score: number }[]) => out[0]!.label === 'INJECTION' ? out[0]!.score : 1 - out[0]!.score

describe('readWhole (#951)', () => {
  it('passes a text that fits straight to the model, once', async () => {
    const { fn, seen } = fakeClassifier()
    const text = 'a'.repeat(MODEL_MAX_TOKENS * 2 - 10)
    await readWhole(fn, injectionScore)(text)
    expect(seen).toEqual([text])
  })

  it('reads a text that runs past the model in pieces that each fit, and keeps the highest score', async () => {
    const { fn, seen } = fakeClassifier()
    // 826 tokens, the largest window measured on Aya; the payload is in the
    // part a single pass truncates.
    const text = 'b'.repeat(1500) + PAYLOAD + 'b'.repeat(140)
    const out = await readWhole(fn, injectionScore)(text)
    expect(out[0]).toEqual({ label: 'INJECTION', score: 0.99 })
    expect(seen.length).toBeGreaterThan(1)
    for (const piece of seen) expect(tokenizer(piece).input_ids.dims[1]).toBeLessThanOrEqual(MODEL_MAX_TOKENS)
    // Every character is read by some piece.
    expect(seen.join('').length).toBeGreaterThanOrEqual(text.length)
    expect(seen.some(p => p.includes(PAYLOAD))).toBe(true)
  })

  it('reads a payload that sits on the seam between two pieces', async () => {
    const { fn, seen } = fakeClassifier()
    const half = Math.floor((MODEL_MAX_TOKENS * 2 + 200) / 2)
    const text = 'c'.repeat(half - 3) + PAYLOAD + 'c'.repeat(half)
    expect((await readWhole(fn, injectionScore)(text))[0]!.label).toBe('INJECTION')
    expect(seen.some(p => p.includes(PAYLOAD))).toBe(true)
  })

  it('keeps the model as it is when it has no tokenizer to count with', async () => {
    const seen: string[] = []
    const bare = (async (t: string) => { seen.push(t); return [{ label: 'SAFE', score: 1 }] }) as ClassifyFn
    const text = 'd'.repeat(5000)
    await readWhole(bare, injectionScore)(text)
    expect(seen).toEqual([text])
  })
})
