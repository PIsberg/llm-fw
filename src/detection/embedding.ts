import { pipeline, env } from '@huggingface/transformers'
import { EmbeddingResult, DetectionConfig } from '../types.js'
import { normalize } from './normalize.js'
import { homedir } from 'node:os'
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

export class EmbeddingChecker {
  private extractor: FeatureExtractor | null = null
  private templateEmbeddings: Float32Array[] = []
  private templateStrings: string[] = []
  private config: DetectionConfig

  constructor(config: DetectionConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    // The model is large, immutable, and safe to share across instances, so it
    // caches in LLM_FW_MODEL_DIR when set — this lets CI cache it independently
    // of the per-instance LLM_FW_DIR (which the tests point at a throwaway temp
    // dir). Falls back to <LLM_FW_DIR or ~/.llm-fw>/models.
    const baseDir = process.env.LLM_FW_DIR || join(homedir(), '.llm-fw')
    env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(baseDir, 'models')
    env.allowLocalModels = false

    try {
      // Multilingual sentence model (50+ languages, same 384-dim output as the
      // former English-only all-MiniLM-L6-v2, so cosineSimilarity is unchanged).
      // This lets Stage 2 cluster a non-English attack near its translated
      // template in data/attacks.json — the monolingual model could not.
      // NOTE: the similarity distribution differs from the old model, so the
      // embeddingBlock/Warn thresholds (config.ts) may need re-tuning against a
      // labelled corpus; multilingual encoders tend to run higher baseline
      // cosine, which can raise false positives if the thresholds are left as-is.
      this.extractor = (await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', { dtype: 'q8' })) as unknown as FeatureExtractor
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

    const __filename = fileURLToPath(import.meta.url)
    const attacksPath = join(dirname(__filename), '../../data/attacks.json')
    const attacks = JSON.parse(readFileSync(attacksPath, 'utf-8')) as string[]

    for (const attack of attacks) {
      this.templateEmbeddings.push(await this.embed(attack))
      this.templateStrings.push(attack)
    }
  }

  private async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error('Embedding model not initialized')
    const output = await this.extractor([text], { pooling: 'mean', normalize: true })
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
    const norm = normalize(input)
    const chunks = this.chunk(norm)
    let maxSim = 0
    let nearestIdx = 0

    for (const chunk of chunks) {
      const emb = await this.embed(chunk)
      for (let i = 0; i < this.templateEmbeddings.length; i++) {
        const sim = this.cosineSimilarity(emb, this.templateEmbeddings[i])
        if (sim > maxSim) {
          maxSim = sim
          nearestIdx = i
        }
      }
    }

    return {
      similarity: maxSim,
      nearest: this.templateStrings[nearestIdx] ?? '',
      chunkCount: chunks.length,
    }
  }

  isInitialized(): boolean {
    return this.extractor !== null
  }
}
