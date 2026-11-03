/**
 * A smaller table for the tokenizer's vocabulary.
 *
 * transformers.js builds its Unigram tokenizer's trie as one object plus one Map
 * per node. The embedding model's 250,000-token vocabulary makes 505,207 nodes,
 * which is 137 of the 187 MB of heap the process holds once the tokenizer has
 * loaded, measured on 2026-11-03. Encoding only ever asks one question of it:
 * which vocabulary entries start at this position. A flat hash table answers
 * that in 13 MB, and about 10% faster.
 *
 * It must answer exactly as the shipped trie does, because a different token
 * moves every vector and with them every calibrated threshold.
 * `test/detection/compactTokenizer.test.ts` holds it to that on the real
 * tokenizer, and fails if a transformers bump renames what this reaches into.
 */

const INITIAL_SLOTS = 1 << 12
const MAX_LOAD = 0.66

export class CompactTrie {
  // Open addressing over (node, UTF-16 unit). Slot i holds the parent node plus
  // one in keys[2i] (so 0 means empty), the unit in keys[2i + 1], the child in
  // children[i]. Node 0 is the root.
  private keys = new Int32Array(INITIAL_SLOTS * 2)
  private children = new Int32Array(INITIAL_SLOTS)
  private mask = INITIAL_SLOTS - 1
  private leaf = new Uint8Array(INITIAL_SLOTS)
  private nodes = 1

  constructor(vocab: readonly string[]) {
    for (const entry of vocab) {
      let node = 0
      for (let i = 0; i < entry.length; i++) node = this.insert(node, entry.charCodeAt(i))
      // An empty entry marks the root, which a search never reports: it reports
      // only after stepping, as the shipped trie does.
      this.leaf[node] = 1
    }
    this.leaf = this.leaf.slice(0, this.nodes)
  }

  private slot(node: number, unit: number): number {
    return (Math.imul(node, 0x9E3779B1) ^ Math.imul(unit, 0x85EBCA6B)) & this.mask
  }

  private insert(node: number, unit: number): number {
    if (this.nodes >= (this.mask + 1) * MAX_LOAD) this.grow()
    for (let i = this.slot(node, unit); ; i = (i + 1) & this.mask) {
      const key = this.keys[2 * i]
      if (key === 0) {
        const child = this.nodes++
        this.keys[2 * i] = node + 1
        this.keys[2 * i + 1] = unit
        this.children[i] = child
        if (child >= this.leaf.length) {
          const larger = new Uint8Array(this.leaf.length * 2)
          larger.set(this.leaf)
          this.leaf = larger
        }
        return child
      }
      if (key === node + 1 && this.keys[2 * i + 1] === unit) return this.children[i] as number
    }
  }

  private grow(): void {
    const { keys, children } = this
    const slots = (this.mask + 1) * 2
    this.keys = new Int32Array(slots * 2)
    this.children = new Int32Array(slots)
    this.mask = slots - 1
    for (let old = 0; old < children.length; old++) {
      const key = keys[2 * old] as number
      if (key === 0) continue
      const unit = keys[2 * old + 1] as number
      let i = this.slot(key - 1, unit)
      while (this.keys[2 * i] !== 0) i = (i + 1) & this.mask
      this.keys[2 * i] = key
      this.keys[2 * i + 1] = unit
      this.children[i] = children[old] as number
    }
  }

  private step(node: number, unit: number): number {
    for (let i = this.slot(node, unit); ; i = (i + 1) & this.mask) {
      const key = this.keys[2 * i]
      if (key === 0) return -1
      if (key === node + 1 && this.keys[2 * i + 1] === unit) return this.children[i] as number
    }
  }

  /** The entries that are a prefix of `chars` from `start`, shortest first. */
  *common_prefix_search(chars: readonly string[], start = 0): Generator<string> {
    let node = 0
    let prefix = ''
    for (let i = start; i < chars.length; i++) {
      const ch = chars[i] as string
      prefix += ch
      // A character is one or two units, and an entry can only end after a whole
      // one, so half of a surrogate pair never matches.
      for (let u = 0; u < ch.length; u++) {
        node = this.step(node, ch.charCodeAt(u))
        if (node === -1) return
      }
      if (this.leaf[node] === 1) yield prefix
    }
  }
}

interface TokenizerShape {
  _tokenizerJSON?: unknown
  _tokenizer?: { model?: { trie?: { common_prefix_search?: unknown }; vocab?: unknown; config?: { vocab?: unknown } } }
}

/**
 * Swap a loaded tokenizer's trie for a CompactTrie and drop the parsed vocabulary
 * encoding no longer reads. Returns false, changing nothing, for a tokenizer of
 * any other shape: most models use one without this trie, and this saves memory
 * but must never decide whether a model works.
 */
export function compactTokenizer(tokenizer: unknown): boolean {
  const shape = tokenizer as TokenizerShape | null | undefined
  const model = shape?._tokenizer?.model
  if (!model || typeof model.trie?.common_prefix_search !== 'function' || !Array.isArray(model.vocab)) return false
  model.trie = new CompactTrie(model.vocab as string[])
  if (model.config) delete model.config.vocab
  delete shape._tokenizerJSON
  return true
}
