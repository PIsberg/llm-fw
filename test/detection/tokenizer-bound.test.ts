import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { env } from '@huggingface/transformers'
import { loadEmbeddingExtractor, type FeatureExtractor } from '../../src/detection/embedding.js'

// GHSA-gm3q-2gwx-gppq. transformers.js's Unigram populate_nodes used to copy the
// whole rest of the text at every position, so tokenizing dense text was
// quadratic: a 100 KB base64 prompt spent 35 s in the tokenizer, on the thread
// that serves every request. llm-fw patched it until transformers 4.3 fixed it
// upstream (`common_prefix_search(chars, begin_pos)`, #511). This pins the
// behaviour, so a later release that brings the cost back fails here.
type Tok = { encode: (text: string) => number[] }

describe('embedding tokenizer: dense text stays linear', { timeout: 300_000 }, () => {
  let tokenizer: Tok

  beforeAll(async () => {
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(homedir(), '.llm-fw', 'models')
    const extractor = await loadEmbeddingExtractor() as FeatureExtractor & { tokenizer: Tok }
    tokenizer = extractor.tokenizer
  })

  it('tokenizes a 4,096-character dense chunk quickly', () => {
    const chunk = Buffer.from(Array.from({ length: 3072 }, (_, i) => (i * 131 + 7) % 256)).toString('base64url')
    const t0 = performance.now()
    for (let i = 0; i < 10; i++) tokenizer.encode(chunk)
    expect(performance.now() - t0).toBeLessThan(1500)
  })

  it('tokenizes 100 KB of base64 in seconds, not the 35 s of the quadratic version', () => {
    const text = Buffer.from(Array.from({ length: 75_000 }, (_, i) => (i * 37 + (i >> 3)) % 256)).toString('base64')
    const t0 = performance.now()
    tokenizer.encode(text)
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})
