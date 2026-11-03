import { describe, it, expect, vi } from 'vitest'

const check = vi.fn(async () => ({ similarity: 0, nearest: '', chunkCount: 1 }))
vi.mock('../../src/detection/embedding.js', () => ({
  EmbeddingChecker: vi.fn().mockImplementation(function() {
    return { init: vi.fn(), check, isInitialized: vi.fn().mockReturnValue(true) }
  }),
}))

import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// A code file holds hundreds of joined identifiers. The rules are what they add;
// a forward pass for each would spend detection.embeddingMaxPassesPerRequest on
// code, and old history would go unread for it (#641).
describe('joined words and the embedding stage', () => {
  it('reads the text, and not its identifiers, with the model', async () => {
    const c = structuredClone(DEFAULT_CONFIG)
    c.enforcement = 'enforce'
    c.detection.judgeEnabled = false
    await new Pipeline(c).run('/v1/messages', JSON.stringify({
      model: 'm', max_tokens: 5,
      messages: [{ role: 'user', content: 'What does alpha_beta_gamma_delta do here?' }],
    }), { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' })

    const read = check.mock.calls.map(call => String((call as unknown[])[0]))
    expect(read.some(t => t.includes('alpha'))).toBe(true)
    expect(read).not.toContain('alpha beta gamma delta')
  })
})
