import { pipeline, env } from '@huggingface/transformers'
import { EmbeddingResult, DetectionConfig } from '../types.js'
import { normalize } from './normalize.js'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export class EmbeddingChecker {
  private extractor: any = null
  private templateEmbeddings: Float32Array[] = []
  private templateStrings: string[] = []
  private config: DetectionConfig

  constructor(config: DetectionConfig) {
    this.config = config
  }

  async init(): Promise<void> {
    env.cacheDir = join(homedir(), '.llm-fw', 'models')
    env.allowLocalModels = false
    this.extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' })

    const __filename = fileURLToPath(import.meta.url)
    const attacksPath = join(dirname(__filename), '../../data/attacks.json')
    const attacks: string[] = JSON.parse(readFileSync(attacksPath, 'utf-8'))

    // Batch embed all templates in one forward pass instead of 100 sequential calls.
    // ONNX can parallelise the batch using SIMD/threading, cutting startup from ~10s to <200ms.
    const batchOutput = await this.extractor(attacks, { pooling: 'mean', normalize: true })
    // The batch result is a Tensor2D of shape [N, dim]. Extract each row as Float32Array.
    const flatData: Float32Array = batchOutput.data instanceof Float32Array
      ? batchOutput.data
      : Float32Array.from(batchOutput.data)
    const dim = flatData.length / attacks.length

    for (let i = 0; i < attacks.length; i++) {
      this.templateEmbeddings.push(flatData.slice(i * dim, (i + 1) * dim))
      this.templateStrings.push(attacks[i])
    }
  }

  private async embed(text: string): Promise<Float32Array> {
    const output = await this.extractor([text], { pooling: 'mean', normalize: true })
    const raw = output[0]?.data ?? output.data ?? output.tolist?.()[0]
    return raw instanceof Float32Array ? raw : Float32Array.from(raw)
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
