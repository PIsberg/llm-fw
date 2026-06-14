import { pipeline, env } from '@huggingface/transformers'
import { EmbeddingResult, DetectionConfig } from '../types.js'
import { normalizeSemantic } from './normalize.js'
import { createHash } from 'node:crypto'
import { getLlmFwDir } from '../config/paths.js'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Minimal shape of the @huggingface/transformers feature-extraction output we use.
interface FeatureTensor {
  data?: Float32Array | number[]
  tolist?: () => number[][]
  [index: number]: { data?: Float32Array | number[] } | undefined
}
type FeatureExtractor = (texts: string[], opts: { pooling: 'mean'; normalize: boolean }) => Promise<FeatureTensor>

// check() results for repeated identical (normalized) inputs. Proxy traffic is
// highly repetitive — client retries, agent loops re-sending the same system
// prefix, identical tool descriptions on every call — so a small LRU skips the
// model entirely for the common case. Keyed by content hash so the map never
// pins large prompt strings in memory.
//
// NOTE: texts are deliberately embedded ONE AT A TIME, never batched. Batching
// pads shorter texts in the quantized (q8) forward pass and measurably shifts
// the resulting vectors (~4e-3 in 1-cos for the anchor set — enough to move a
// borderline benign prompt across the tuned block threshold). The thresholds in
// config.ts are calibrated against single-text embeddings; keep them
// bit-identical.
const CACHE_MAX_ENTRIES = 512

export class EmbeddingChecker {
  private extractor: FeatureExtractor | null = null
  private templateEmbeddings: Float32Array[] = []
  private templateStrings: string[] = []
  // Benign-intent anchors (agentic task commands, content/info requests). Used
  // only as a contrastive reference: a prompt blocks when it is closer to an
  // injection anchor than to any of these, which is what distinguishes "ignore
  // your instructions" from "commit the changes" — both of which e5 scores high.
  private benignEmbeddings: Float32Array[] = []
  private config: DetectionConfig
  private cache = new Map<string, EmbeddingResult>()

  constructor(config: DetectionConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    // The model is large, immutable, and safe to share across instances, so it
    // caches in LLM_FW_MODEL_DIR when set — this lets CI cache it independently
    // of the per-instance LLM_FW_DIR (which the tests point at a throwaway temp
    // dir). Falls back to <LLM_FW_DIR or ~/.llm-fw>/models.
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
    env.allowLocalModels = false

    try {
      // multilingual-e5-small: a 384-dim sentence encoder (drop-in for the
      // former model's dimension) with genuine cross-lingual alignment across
      // 100 languages. This matters because the previous model
      // (paraphrase-multilingual-MiniLM) has UNUSABLE representations for many
      // lower-resource languages — empirically it scored a benign Bengali
      // question HIGHER against an injection than an actual Bengali injection,
      // so coverage was accidental (Swedish blocked, Urdu/Hindi/Tamil/Thai/…
      // passed). E5 aligns an injection in ANY language to the English intent
      // anchors below (attack ~0.87, benign ~0.66 to the same anchor), giving a
      // uniform cross-lingual separation the old model lacked.
      //
      // E5 expects an asymmetric "query:"/"passage:" prefix. For this symmetric
      // short-text similarity task we use "query: " on both sides (see embed());
      // the prefix is REQUIRED — without it E5 embeddings are mis-calibrated.
      // Thresholds are re-tuned for E5's distribution in config.ts.
      this.extractor = (await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' })) as unknown as FeatureExtractor
    } catch (err) {
      // The semantic-similarity stage is best-effort. If the model can't be
      // fetched (offline, or HuggingFace rate-limits the download with a 429),
      // don't take the whole firewall down — log and leave the stage disabled.
      // The pipeline guards Stage 2 behind isInitialized(), so heuristics, DLP,
      // MCP, URL filtering and DoS keep working; only embedding similarity is
      // skipped until the model becomes reachable.
      this.extractor = null
      console.warn(`[llm-fw] embedding model unavailable — semantic similarity stage disabled (${(err as Error).message})`)
      return
    }

    // Curated canonical injection-intent anchors (data/semantic-anchors.json),
    // English-only. E5's cross-lingual alignment maps an injection in any
    // language onto these, so a small clean anchor set generalizes to every
    // language. We deliberately do NOT use data/attacks.json here: it contains
    // encoded/obfuscated strings (base64, hex, morse) meant for the decode path,
    // which are noisy semantic anchors that benign text accidentally matches and
    // erode the separation. The decode path re-scores DECODED text against these
    // clean anchors instead.
    const __filename = fileURLToPath(import.meta.url)
    const anchorsPath = join(dirname(__filename), '../../data/semantic-anchors.json')
    const anchors = JSON.parse(readFileSync(anchorsPath, 'utf-8')) as string[]

    for (const anchor of anchors) {
      this.templateEmbeddings.push(await this.embed(anchor))
      this.templateStrings.push(anchor)
    }

    // Benign contrastive anchors. Same encoder, embedded one at a time. Missing
    // file → empty set → benignSimilarity 0 → margin == similarity (i.e. the
    // pre-contrastive behaviour), so the stage degrades gracefully.
    try {
      const benignPath = join(dirname(__filename), '../../data/semantic-anchors-benign.json')
      const benign = JSON.parse(readFileSync(benignPath, 'utf-8')) as string[]
      for (const b of benign) this.benignEmbeddings.push(await this.embed(b))
    } catch { /* no benign anchors — contrastive margin falls back to raw similarity */ }
  }

  private async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error('Embedding model not initialized')
    // E5 requires the "query: " task prefix; omitting it mis-calibrates the
    // embedding. Both anchors and inputs use the same prefix (symmetric task).
    const output = await this.extractor(['query: ' + text], { pooling: 'mean', normalize: true })
    const raw = output[0]?.data ?? output.data ?? output.tolist?.()[0]
    return raw instanceof Float32Array ? raw : Float32Array.from(raw ?? [])
  }

  private cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    normA = Math.sqrt(normA)
    normB = Math.sqrt(normB)
    if (normA === 0 || normB === 0) return 0
    return Math.min(1, Math.max(0, dot / (normA * normB)))
  }

  private chunk(text: string): string[] {
    const words = text.split(/\s+/)
    const estimated = words.length * 1.3
    if (estimated <= this.config.chunkTokenLimit) return [text]

    const chunkSize = Math.floor(this.config.chunkTokenLimit / 1.3)
    const chunkOverlap = Math.floor(chunkSize * 0.2)
    const step = chunkSize - chunkOverlap
    const chunks: string[] = []

    for (let start = 0; start < words.length; start += step) {
      const slice = words.slice(start, start + chunkSize)
      chunks.push(slice.join(' '))
      if (start + chunkSize >= words.length) break
    }

    return chunks
  }

  async check(input: string): Promise<EmbeddingResult> {
    // Semantic normalization PRESERVES diacritics/script (see normalizeSemantic):
    // the multilingual encoder needs natural text. Note the pipeline already
    // passes a heuristic-normalized candidate here, but for prompt text that
    // candidate is the lightly-processed 'original'; diacritic-bearing scripts
    // survive because the embedding re-normalizes semantically rather than
    // inheriting the diacritic-stripped form.
    const norm = normalizeSemantic(input)
    // Empty / whitespace-only input carries no semantic content, but E5 still
    // produces an embedding for the bare "query: " prefix that happens to sit
    // ~0.83 from some anchors — enough to trip a spurious warn. (This is how an
    // all-invisible-character payload, once its hidden chars are stripped to
    // nothing, would warn with ASCII-smuggling detection turned off.) Short-
    // circuit to zero similarity so trivial input never flags.
    if (norm.length < 2) {
      return { similarity: 0, nearest: '', chunkCount: 0 }
    }

    const key = createHash('sha256').update(norm).digest('base64')
    const cached = this.cache.get(key)
    if (cached) {
      // Re-insert to mark as most-recently-used (Map preserves insertion order).
      this.cache.delete(key)
      this.cache.set(key, cached)
      return cached
    }

    const chunks = this.chunk(norm)
    let maxSim = 0
    let nearestIdx = 0
    let benignAtMax = 0 // nearest-benign cosine for the chunk that maximised maxSim

    for (const chunk of chunks) {
      const emb = await this.embed(chunk)
      let injSim = 0
      let injIdx = 0
      for (let i = 0; i < this.templateEmbeddings.length; i++) {
        const sim = this.cosineSimilarity(emb, this.templateEmbeddings[i])
        if (sim > injSim) {
          injSim = sim
          injIdx = i
        }
      }
      if (injSim > maxSim) {
        maxSim = injSim
        nearestIdx = injIdx
        // Contrastive reference from the SAME chunk: how benign-like is the most
        // injection-like span? A large gap ⇒ genuine injection; a small/negative
        // gap ⇒ a benign command that merely shares the imperative shape.
        let benignSim = 0
        for (const b of this.benignEmbeddings) {
          const s = this.cosineSimilarity(emb, b)
          if (s > benignSim) benignSim = s
        }
        benignAtMax = benignSim
      }
    }

    const result: EmbeddingResult = {
      similarity: maxSim,
      benignSimilarity: benignAtMax,
      nearest: this.templateStrings[nearestIdx] ?? '',
      chunkCount: chunks.length,
    }
    this.cache.set(key, result)
    if (this.cache.size > CACHE_MAX_ENTRIES) {
      this.cache.delete(this.cache.keys().next().value as string)
    }
    return result
  }

  isInitialized(): boolean {
    return this.extractor !== null
  }
}
