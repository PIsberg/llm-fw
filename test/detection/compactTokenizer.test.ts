import { describe, it, expect, beforeAll } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { env, AutoTokenizer } from '@huggingface/transformers'
import { CompactTrie, compactTokenizer } from '../../src/detection/compactTokenizer.js'
import { EMBEDDING_MODEL_ID } from '../../src/detection/embedding.js'

// The tokenizer's own trie is a Map per node over a 250,000-token vocabulary:
// about 137 MB of heap for a table only ever asked which vocabulary entries
// start at a position. A different token would move every verdict, so what these
// tests pin is that the replacement answers exactly as the shipped trie does.

const search = (trie: CompactTrie, text: string, start = 0) => Array.from(trie.common_prefix_search(Array.from(text), start))

describe('CompactTrie', () => {
  it('yields every vocabulary entry starting at the position, shortest first', () => {
    const trie = new CompactTrie(['a', 'ab', 'abc', 'b', 'xyz'])
    expect(search(trie, 'abcd')).toEqual(['a', 'ab', 'abc'])
    expect(search(trie, 'abcd', 1)).toEqual(['b'])
    expect(search(trie, 'abcd', 3)).toEqual([])
  })

  it('does not yield a prefix that is not itself an entry', () => {
    const trie = new CompactTrie(['abc'])
    expect(search(trie, 'ab')).toEqual([])
    expect(search(trie, 'abc')).toEqual(['abc'])
  })

  it('treats an empty entry as the shipped trie does: it never matches', () => {
    expect(search(new CompactTrie(['', 'a']), 'a')).toEqual(['a'])
    expect(search(new CompactTrie(['']), 'a')).toEqual([])
  })

  it('walks whole characters, so half of a surrogate pair never matches', () => {
    const trie = new CompactTrie(['\u{1F600}', '\u{1F600}x', '\uD83D'])
    expect(search(trie, '\u{1F600}x')).toEqual(['\u{1F600}', '\u{1F600}x'])
    // A lone high surrogate is its own entry only when the input has it alone.
    expect(search(trie, '\uD83D')).toEqual(['\uD83D'])
  })

  it('stays correct while its table grows past the initial size', () => {
    const vocab = Array.from({ length: 50_000 }, (_, i) => `token-${i.toString(36)}`)
    const trie = new CompactTrie(vocab)
    for (const entry of [vocab[0]!, vocab[12_345]!, vocab[49_999]!]) {
      expect(search(trie, entry)).toContain(entry)
    }
    expect(search(trie, 'not-in-the-vocabulary')).toEqual([])
    expect(search(trie, 'token-')).toEqual([])
  })

  it('answers no differently from the shipped trie on a random vocabulary', () => {
    // A small alphabet makes shared prefixes, which is where a trie goes wrong.
    let seed = 1234
    const next = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n }
    const alphabet = ['a', 'b', 'c', 'é', '中', '\u{1F600}']
    const word = (max: number) => Array.from({ length: 1 + next(max) }, () => alphabet[next(alphabet.length)]!).join('')
    const vocab = Array.from({ length: 2000 }, () => word(8))
    const set = new Set(vocab)
    const trie = new CompactTrie(vocab)
    for (let t = 0; t < 2000; t++) {
      const chars = Array.from(word(12))
      const start = next(chars.length)
      const expected: string[] = []
      for (let end = start + 1; end <= chars.length; end++) {
        const piece = chars.slice(start, end).join('')
        if (set.has(piece)) expected.push(piece)
      }
      expect(Array.from(trie.common_prefix_search(chars, start))).toEqual(expected)
    }
  })
})

describe('compactTokenizer', () => {
  it('leaves a tokenizer of another shape alone rather than throwing', () => {
    expect(compactTokenizer({})).toBe(false)
    expect(compactTokenizer(null)).toBe(false)
    expect(compactTokenizer({ _tokenizer: { model: { vocab: ['a'] } } })).toBe(false)
    const trieOnly = { _tokenizer: { model: { trie: {} } } }
    expect(compactTokenizer(trieOnly)).toBe(false)
    expect(trieOnly._tokenizer.model.trie).toEqual({})
  })

  describe('on the real embedding tokenizer', () => {
    const texts = [
      'query: Run the tests and commit the changes when they pass.',
      'query: 日本語のテキストと한국어 العربية \u{1F916}\u{1F9EA} \u{1D518}\u{1D52B}\u{1D526}\u{1D520}\u{1D52C}\u{1D521}\u{1D522}',
      'query: Ign​ore zero‍width ‮reversed‬ text',
      'query: ',
      'query: \u{1F600}\u{1F600}x',
      `query: ${'long-unbroken-word'.repeat(40)}`,
    ]
    const ids = (tok: (t: string) => { input_ids: { data: ArrayLike<bigint> } }, t: string) => Array.from(tok(t).input_ids.data, Number)
    let tokenizer: Record<string, unknown> & ((t: string) => { input_ids: { data: ArrayLike<bigint> } })
    let before: number[][]
    let compacted: boolean

    beforeAll(async () => {
      env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(tmpdir(), 'llm-fw-model-cache')
      env.allowLocalModels = false
      tokenizer = await AutoTokenizer.from_pretrained(EMBEDDING_MODEL_ID) as never
      before = texts.map(t => ids(tokenizer, t))
      compacted = compactTokenizer(tokenizer)
    }, 120_000)

    // Fails, loudly, when a transformers bump renames the internals this reaches
    // into: without it the firewall would silently carry the extra 137 MB again.
    it('recognises the shape and replaces the trie', () => {
      expect(compacted).toBe(true)
      expect((tokenizer as unknown as { _tokenizer: { model: { trie: unknown } } })._tokenizer.model.trie).toBeInstanceOf(CompactTrie)
    })

    it('produces the same tokens as before', () => {
      expect(texts.map(t => ids(tokenizer, t))).toEqual(before)
    })

    it('releases the parsed vocabulary it no longer needs', () => {
      const t = tokenizer as unknown as { _tokenizerJSON?: unknown; _tokenizer: { model: { config?: { vocab?: unknown } } } }
      expect(t._tokenizerJSON).toBeUndefined()
      expect(t._tokenizer.model.config?.vocab).toBeUndefined()
    })
  })
})
