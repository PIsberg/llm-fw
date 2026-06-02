/* eslint-disable @typescript-eslint/require-await */
import { Config, PipelineResult, BlockEvent } from '../types.js'
import { getParser, extractPartialPrompts } from './parsers.js'
import { HeuristicScorer } from './heuristic.js'
import { EmbeddingChecker } from './embedding.js'
import { JudgeClient } from './judge.js'
import { extractCandidates, maxWindowEntropy } from './normalize.js'
import { extractRagContext, ragInjectionScore, RagContextBlock } from './rag/parser.js'

export class Pipeline {
  private heuristic: HeuristicScorer
  private embedding: EmbeddingChecker
  private judge: JudgeClient
  private config: Config
  private onBlock?: (event: Omit<BlockEvent, 'id' | 'timestamp'>) => void

  constructor(config: Config, onBlock?: (event: Omit<BlockEvent, 'id' | 'timestamp'>) => void) {
    this.config = config
    this.onBlock = onBlock
    this.heuristic = new HeuristicScorer()
    this.embedding = new EmbeddingChecker(config.detection)
    this.judge = new JudgeClient(config.detection)
  }

  async init(): Promise<void> { await this.embedding.init() }

  async run(
    requestPath: string,
    body: string,
    meta: { target: string; method: string; path: string }
  ): Promise<PipelineResult> {
    const parser = getParser(requestPath)
    if (!parser) return this.pass(0, 0)

    const prompts = parser.extractPrompts(body)
    if (!prompts.length) return this.pass(0, 0)

    const { heuristicBlockThreshold, embeddingBlockThreshold, embeddingWarnThreshold, judgeEnabled, judgeBlock } = this.config.detection
    let lastScore = 0
    let lastSim = 0

    const { heuristicBlockThreshold: ragBlockThreshold } = this.config.detection
    const ragEnabled = this.config.rag?.enabled

    for (const prompt of prompts) {
      // Stage R — RAG context-poisoning. Isolate retrieved data blocks
      // (<document>, <context>, <search_results>, code fences) and check whether
      // they smuggle active instructions. Two independent signals can block:
      //   1. Structural heuristic — injection keywords confined to a data block.
      //   2. Specialized judge — semantic intent of an isolated data block.
      if (ragEnabled) {
        const ragBlocks = extractRagContext(prompt)
        if (ragBlocks.length) {
          // Signal 1: structural boundary-violation heuristic (deterministic).
          const ragHeur = ragInjectionScore(prompt, this.heuristic)
          if (ragHeur.score >= ragBlockThreshold) {
            const result: PipelineResult = { action: 'block', stage: 'rag', score: ragHeur.score, similarity: 0, prompt, heuristicMatches: ragHeur.matches }
            this.emit(result, meta, prompt)
            return result
          }

          // Signal 2: specialized judge on each isolated data block. Bounded
          // concurrency + dedup + short-circuit so a prompt stuffed with many
          // blocks cannot flood the local Ollama instance.
          if (judgeEnabled) {
            const poisoned = await this.judgeRagBlocks(ragBlocks)
            if (poisoned) {
              const result: PipelineResult = { action: 'block', stage: 'rag', score: 50, similarity: 0, verdict: 'MALICIOUS', prompt, ragTag: poisoned.tag }
              this.emit(result, meta, prompt)
              return result
            }
          }
        }
      }

      // Active evasion check — route to the Stage 3 judge when a DENSE pocket of
      // high entropy is present. Using a sliding-window max (not the whole-prompt
      // average) so a small base64/hex payload hidden in a large benign prompt is
      // not diluted below the threshold by the surrounding text.
      const entropy = maxWindowEntropy(prompt)
      if (entropy > 5.0 && prompt.length >= 20 && judgeEnabled) {
        const j = await this.judge.classify(prompt)
        if (j.verdict === 'MALICIOUS') {
          const result: PipelineResult = { action: 'block', stage: 'judge', score: 30, similarity: 0, verdict: 'MALICIOUS', prompt }
          this.emit(result, meta, prompt)
          return result
        }
      }

      const candidates = extractCandidates(prompt)
      for (const candidate of candidates) {
        // Stage 1: heuristic
        const h = this.heuristic.score(candidate.text, candidate.source)
        lastScore = Math.max(lastScore, h.score)
        
        if (h.score >= heuristicBlockThreshold) {
          const result: PipelineResult = { action: 'block', stage: 'heuristic', score: h.score, similarity: 0, prompt: candidate.text, heuristicMatches: h.matches }
          this.emit(result, meta, prompt)
          return result
        }
        // Stage 2: embedding (always run, it's fast and catches zero-heuristic semantic variants)
        let eSim = 0
        let eNearest = ''
        if (this.embedding.isInitialized()) {
          const e = await this.embedding.check(candidate.text)
          eSim = e.similarity
          eNearest = e.nearest
          lastSim = Math.max(lastSim, eSim)
          
          if (eSim >= embeddingBlockThreshold) {
            const result: PipelineResult = { action: 'block', stage: 'embedding', score: h.score, similarity: eSim, prompt: candidate.text, nearestTemplate: eNearest }
            this.emit(result, meta, prompt)
            return result
          }
        }

        // Are we in the escalation range?
        // A prompt needs to be judged if it is suspicious. It is suspicious if:
        // 1. Heuristic score is >= 20
        // 2. OR Embedding similarity is >= embeddingWarnThreshold
        const isSuspicious = h.score >= 20 || eSim >= embeddingWarnThreshold
        if (!isSuspicious) {
          continue // benign, skip judge and warning
        }

        // Stage 3: Judge (only if suspicious)
        if (judgeEnabled) {
          if (judgeBlock) {
            // Sync blocking mode
            const j = await this.judge.classify(candidate.text)
            if (j.verdict === 'MALICIOUS') {
              const result: PipelineResult = { action: 'block', stage: 'judge', score: h.score, similarity: eSim, verdict: 'MALICIOUS', prompt: candidate.text }
              this.emit(result, meta, prompt)
              return result
            }
          } else {
            // Async monitoring mode
            this.judge.classify(candidate.text).then(j => {
              if (j.verdict === 'MALICIOUS') {
                this.emit({ action: 'warn', stage: 'judge', score: h.score, similarity: eSim, verdict: 'MALICIOUS', prompt: candidate.text }, meta, prompt)
              }
            }).catch(() => {})
          }
        }

        // If the judge didn't block it, we only return a 'warn' if the embedding
        // similarity explicitly crossed the warning threshold.
        if (eSim >= embeddingWarnThreshold) {
          const result: PipelineResult = { 
            action: 'warn', 
            stage: 'embedding', 
            score: h.score, 
            similarity: eSim, 
            prompt: candidate.text, 
            nearestTemplate: eNearest,
            heuristicMatches: h.matches 
          }
          this.emit(result, meta, prompt)
          return result
        }

        // If it was just elevated heuristics (score < block threshold) and the
        // embedding/judge didn't flag it, it's considered safe. We continue
        // evaluating other candidates, eventually passing.
      }
    }

    return this.pass(lastScore, lastSim)
  }

  async checkPartial(
    requestPath: string,
    partialBody: string,
    meta: { target: string; method: string; path: string }
  ): Promise<PipelineResult | null> {
    const parser = getParser(requestPath)
    if (!parser) return null

    const prompts = extractPartialPrompts(partialBody)
    const { heuristicBlockThreshold } = this.config.detection

    for (const prompt of prompts) {
      const candidates = extractCandidates(prompt)
      for (const candidate of candidates) {
        const h = this.heuristic.score(candidate.text, candidate.source)
        if (h.score >= heuristicBlockThreshold) {
          const result: PipelineResult = {
            action: 'block',
            stage: 'heuristic',
            score: h.score,
            similarity: 0,
            prompt: candidate.text,
            heuristicMatches: h.matches
          }
          this.emit(result, meta, prompt)
          return result
        }
      }
    }
    return null
  }

  // Max concurrent specialized-judge queries for RAG data blocks. A prompt with
  // dozens of small code/document blocks would otherwise fire dozens of parallel
  // requests at the single local Ollama instance and overwhelm the GPU/CPU.
  private static readonly RAG_JUDGE_CONCURRENCY = 3

  /**
   * Judge isolated RAG data blocks for context poisoning with bounded
   * concurrency. Identical blocks are judged only once, blocks are processed in
   * batches of RAG_JUDGE_CONCURRENCY, and the scan short-circuits on the first
   * MALICIOUS verdict. Returns the poisoned block, or null if all are clean.
   */
  private async judgeRagBlocks(blocks: RagContextBlock[]): Promise<RagContextBlock | null> {
    const seen = new Set<string>()
    const unique = blocks.filter(b => {
      if (seen.has(b.block)) return false
      seen.add(b.block)
      return true
    })
    for (let i = 0; i < unique.length; i += Pipeline.RAG_JUDGE_CONCURRENCY) {
      const batch = unique.slice(i, i + Pipeline.RAG_JUDGE_CONCURRENCY)
      const verdicts = await Promise.all(
        batch.map(b => this.judge.judgeRagContext(b.block).then(j => ({ b, verdict: j.verdict })))
      )
      const hit = verdicts.find(v => v.verdict === 'MALICIOUS')
      if (hit) return hit.b
    }
    return null
  }

  private pass(score: number, similarity: number): PipelineResult {
    return { action: 'pass', stage: 'none', score, similarity }
  }

  private emit(result: Pick<PipelineResult, 'action'|'stage'|'score'|'similarity'|'heuristicMatches'|'nearestTemplate'|'ragTag'> & { verdict?: string; prompt?: string }, meta: { target: string; method: string; path: string }, prompt: string): void {
    if (!this.onBlock) return
    this.onBlock({
      stage: result.stage,
      score: result.score,
      similarity: result.similarity,
      target: meta.target,
      method: meta.method,
      path: meta.path,
      payload_preview: prompt.slice(0, 120),
      payload_full: prompt,
      action: result.action === 'block' ? 'blocked' : 'warned',
      heuristicMatches: result.heuristicMatches,
      nearestTemplate: result.nearestTemplate,
      verdict: result.verdict,
      kind: result.stage === 'rag' ? 'rag' : undefined,
      ragTag: result.ragTag,
    })
  }
}
