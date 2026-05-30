import { Config, PipelineResult, BlockEvent } from '../types.js'
import { getParser, extractPartialPrompts } from './parsers.js'
import { HeuristicScorer } from './heuristic.js'
import { EmbeddingChecker } from './embedding.js'
import { JudgeClient } from './judge.js'
import { extractCandidates, calculateEntropy } from './normalize.js'

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

    for (const prompt of prompts) {
      // Active evasion high entropy check - immediately route to Stage 3 Judge if enabled
      const entropy = calculateEntropy(prompt)
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
        if (h.score < 20) continue

        // Stage 2: embedding (only if score is in escalation range)
        if (this.embedding.isInitialized()) {
          const e = await this.embedding.check(candidate.text)
          lastSim = Math.max(lastSim, e.similarity)
          if (e.similarity >= embeddingBlockThreshold) {
            const result: PipelineResult = { action: 'block', stage: 'embedding', score: h.score, similarity: e.similarity, prompt: candidate.text, nearestTemplate: e.nearest }
            this.emit(result, meta, prompt)
            return result
          }
          if (e.similarity >= embeddingWarnThreshold) {
            const result: PipelineResult = { action: 'warn', stage: 'embedding', score: h.score, similarity: e.similarity, prompt: candidate.text, nearestTemplate: e.nearest }
            this.emit(result, meta, prompt)
            // Stage 3 async (monitoring only by default)
            if (judgeEnabled && !judgeBlock) {
              this.judge.classify(candidate.text).then(j => {
                if (j.verdict === 'MALICIOUS') {
                  this.emit({ action: 'warn', stage: 'judge', score: h.score, similarity: e.similarity, verdict: 'MALICIOUS', prompt: candidate.text }, meta, prompt)
                }
              }).catch(() => {})
            }
            return result
          }
        }

        // Stage 3 sync blocking mode
        if (judgeEnabled && judgeBlock) {
          const j = await this.judge.classify(candidate.text)
          if (j.verdict === 'MALICIOUS') {
            const result: PipelineResult = { action: 'block', stage: 'judge', score: h.score, similarity: lastSim, verdict: 'MALICIOUS', prompt: candidate.text }
            this.emit(result, meta, prompt)
            return result
          }
        }
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

  private pass(score: number, similarity: number): PipelineResult {
    return { action: 'pass', stage: 'none', score, similarity }
  }

  private emit(result: Pick<PipelineResult, 'action'|'stage'|'score'|'similarity'|'heuristicMatches'|'nearestTemplate'> & { verdict?: string; prompt?: string }, meta: { target: string; method: string; path: string }, prompt: string): void {
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
    })
  }
}
