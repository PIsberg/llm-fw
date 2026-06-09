/* eslint-disable @typescript-eslint/require-await */
import { Config, PipelineResult, BlockEvent } from '../types.js'
import { getParser, extractPartialPrompts, extractToolDescriptions } from './parsers.js'
import { HeuristicScorer } from './heuristic.js'
import { EmbeddingChecker } from './embedding.js'
import { JudgeClient } from './judge.js'
import { extractCandidates, maxWindowEntropy } from './normalize.js'
import { detectHiddenChars } from './asciiSmuggling.js'
import { extractRagContext, ragInjectionScore, RagContextBlock } from './rag/parser.js'

// Provenance of a scanned text fragment — which attacker-influenceable surface
// it came from. Drives the event label so the dashboard distinguishes a direct
// prompt injection from an indirect one (tool result) or a poisoned tool def.
type ScanSource = 'prompt' | 'tool_result' | 'tool_definition'

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
    meta: { target: string; method: string; path: string; sandboxClient?: string; isSandboxed?: boolean; sandboxConfidence?: number; }
  ): Promise<PipelineResult> {
    const parser = getParser(requestPath)
    if (!parser) return this.pass(0, 0)

    // The model reads and acts on more than the user's typed prompt. Inspect
    // every attacker-influenceable surface that reaches the model, not just
    // user/system text:
    //   • prompt          — user + system text (direct injection)
    //   • tool_result     — tool/function output, retrieved docs, MCP responses,
    //                       file contents (INDIRECT injection — the primary
    //                       agentic vector; e.g. Antigravity feeding files back)
    //   • tool_definition — tool/function `description` fields (TOOL POISONING)
    // All three ride the same heuristic → embedding → judge → RAG path below.
    const scanItems: { text: string; source: ScanSource }[] = [
      ...parser.extractPrompts(body).map(text => ({ text, source: 'prompt' as const })),
      ...parser.extractToolResults(body).map(tr => ({ text: tr.result, source: 'tool_result' as const })),
      ...extractToolDescriptions(parser.extractTools(body)).map(text => ({ text, source: 'tool_definition' as const })),
    ].filter(item => item.text && item.text.length > 0)
    if (!scanItems.length) return this.pass(0, 0)

    const { heuristicBlockThreshold, embeddingBlockThreshold, embeddingWarnThreshold, judgeEnabled, judgeBlock } = this.config.detection
    let lastScore = 0
    let lastSim = 0

    const { heuristicBlockThreshold: ragBlockThreshold } = this.config.detection
    const ragEnabled = this.config.rag?.enabled

    // A warn is the WEAKEST positive verdict. It must never short-circuit the
    // scan: a different candidate (e.g. the base64-DECODED form of the same
    // prompt) may still BLOCK, and a block must win over an earlier warn. So we
    // record the first warn and keep scanning every candidate of every surface;
    // the warn is only emitted at the end if nothing blocked. (Previously the
    // warn returned immediately, which let an early embedding-warn on the raw
    // "decode this base64 …" candidate mask the heuristic block on its decoded
    // payload — encoded attacks slipped through as warns.)
    let pendingWarn: { result: PipelineResult; prompt: string; source: ScanSource } | null = null

    for (const { text: prompt, source } of scanItems) {
      // Stage S — ASCII smuggling. Invisible-character instruction smuggling
      // (Unicode Tags block, bidi overrides, plane-14 variation selectors).
      // Checked on the RAW prompt BEFORE normalization strips the characters.
      // Presence of these channels is essentially never legitimate in prompt
      // text, so detection alone blocks. The recovered (decoded) instruction is
      // surfaced in the event so an operator can see what was hidden.
      if (this.config.asciiSmuggling?.enabled) {
        const hidden = detectHiddenChars(prompt)
        if (hidden.hasHidden) {
          const decodedNote = hidden.decoded ? ` decoded: "${hidden.decoded.slice(0, 120)}"` : ''
          const result: PipelineResult = {
            action: 'block',
            stage: 'ascii-smuggling',
            score: 100,
            similarity: 0,
            prompt: hidden.decoded || prompt,
            smuggleRanges: hidden.ranges,
          }
          this.emit(result, meta, `[hidden: ${hidden.ranges.join(', ')}]${decodedNote}`, source)
          return result
        }
      }

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
            this.emit(result, meta, prompt, source)
            return result
          }

          // Signal 2: specialized judge on each isolated data block. Bounded
          // concurrency + dedup + short-circuit so a prompt stuffed with many
          // blocks cannot flood the local Ollama instance.
          if (judgeEnabled) {
            const poisoned = await this.judgeRagBlocks(ragBlocks)
            if (poisoned) {
              const result: PipelineResult = { action: 'block', stage: 'rag', score: 50, similarity: 0, verdict: 'MALICIOUS', prompt, ragTag: poisoned.tag }
              this.emit(result, meta, prompt, source)
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
          this.emit(result, meta, prompt, source)
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
          this.emit(result, meta, prompt, source)
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
            this.emit(result, meta, prompt, source)
            return result
          }
        }

        // Escalation policy — does this candidate reach the Stage 3 judge?
        //
        // Default ("suspicious-only"): the cheap stages must produce a POSITIVE
        // signal first — heuristic >= 20 OR embedding >= warn threshold. Cheap,
        // but it gates the only general stage behind the brittle ones: a
        // well-worded jailbreak that scores 0 on heuristics and sits below the
        // embedding threshold is never judged. This is exactly how the DAN /
        // "fictional unrestricted AI" class slips through.
        //
        // Inverted ("judgeUnlessBenign"): the cheap stages ROUTE rather than
        // VETO. Every candidate is judged UNLESS it is confidently benign. This
        // is the policy that generalizes to novel phrasings — the judge reasons
        // about intent regardless of wording — at the cost of more local judge
        // calls. The heuristic/embedding stages still short-circuit to an early
        // block, and still decide warn-vs-pass below; they just no longer get to
        // suppress the judge on a zero-signal prompt.
        const isSuspicious = h.score >= 20 || eSim >= embeddingWarnThreshold
        const reachesJudge = this.config.detection.judgeUnlessBenign
          ? !this.isConfidentlyBenign(h.score, eSim, candidate.text)
          : isSuspicious
        if (!reachesJudge) {
          continue // benign, skip judge and warning
        }

        // Stage 3: Judge (only if suspicious)
        if (judgeEnabled) {
          if (judgeBlock) {
            // Sync blocking mode
            const j = await this.judge.classify(candidate.text)
            if (j.verdict === 'MALICIOUS') {
              const result: PipelineResult = { action: 'block', stage: 'judge', score: h.score, similarity: eSim, verdict: 'MALICIOUS', prompt: candidate.text }
              this.emit(result, meta, prompt, source)
              return result
            }
          } else {
            // Async monitoring mode
            this.judge.classify(candidate.text).then(j => {
              if (j.verdict === 'MALICIOUS') {
                this.emit({ action: 'warn', stage: 'judge', score: h.score, similarity: eSim, verdict: 'MALICIOUS', prompt: candidate.text }, meta, prompt, source)
              }
            }).catch(() => {})
          }
        }

        // If the judge didn't block it, record a deferred 'warn' when the
        // embedding similarity crossed the warning threshold. We DON'T return
        // here — a later candidate (or surface) may still block, which must
        // take precedence. Keep only the first/strongest warn.
        if (eSim >= embeddingWarnThreshold && !pendingWarn) {
          pendingWarn = {
            result: {
              action: 'warn',
              stage: 'embedding',
              score: h.score,
              similarity: eSim,
              prompt: candidate.text,
              nearestTemplate: eNearest,
              heuristicMatches: h.matches,
            },
            prompt,
            source,
          }
        }

        // If it was just elevated heuristics (score < block threshold) and the
        // embedding/judge didn't flag it, it's considered safe. We continue
        // evaluating other candidates, eventually passing.
      }
    }

    // No candidate blocked. Surface the deferred warn if any candidate crossed
    // the warn threshold; otherwise pass.
    if (pendingWarn) {
      this.emit(pendingWarn.result, meta, pendingWarn.prompt, pendingWarn.source)
      return pendingWarn.result
    }

    return this.pass(lastScore, lastSim)
  }

  async checkPartial(
    requestPath: string,
    partialBody: string,
    meta: { target: string; method: string; path: string; sandboxClient?: string; isSandboxed?: boolean; sandboxConfidence?: number; }
  ): Promise<PipelineResult | null> {
    const parser = getParser(requestPath)
    if (!parser) return null

    const prompts = extractPartialPrompts(partialBody)
    const { heuristicBlockThreshold } = this.config.detection

    for (const prompt of prompts) {
      const source: ScanSource = 'prompt'
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
          this.emit(result, meta, prompt, source)
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

  // Under judgeUnlessBenign, the judge is the default and the cheap stages only
  // earn a SKIP when a candidate is unmistakably harmless: zero heuristic signal,
  // low semantic similarity to every known template, AND too short to plausibly
  // wrap an instruction in a benign-looking scenario. Short malicious prompts
  // ("ignore previous instructions") carry heuristic signal and are blocked
  // earlier; a zero-signal prompt long enough to stage a narrative jailbreak is
  // precisely what the cheap stages cannot adjudicate, so it goes to the judge.
  // BENIGN_LENGTH_CEILING is the cost/coverage tuning knob — lower judges more
  // traffic (safer, more local-LLM calls), higher skips more (cheaper, riskier).
  private static readonly BENIGN_LENGTH_CEILING = 64

  private isConfidentlyBenign(score: number, similarity: number, text: string): boolean {
    return (
      score === 0 &&
      similarity < this.config.detection.embeddingWarnThreshold &&
      text.trim().length < Pipeline.BENIGN_LENGTH_CEILING
    )
  }

  private pass(score: number, similarity: number): PipelineResult {
    return { action: 'pass', stage: 'none', score, similarity }
  }

  private emit(result: Pick<PipelineResult, 'action'|'stage'|'score'|'similarity'|'heuristicMatches'|'nearestTemplate'|'ragTag'|'smuggleRanges'> & { verdict?: string; prompt?: string }, meta: { target: string; method: string; path: string; sandboxClient?: string; isSandboxed?: boolean; sandboxConfidence?: number; }, prompt: string, source: ScanSource = 'prompt'): void {
    if (!this.onBlock) return
    // Tag the provenance inline so a tool-result (indirect) or tool-definition
    // (poisoning) hit is distinguishable from a direct prompt injection in the
    // existing Live Traffic UI without a schema change.
    const label = source === 'tool_result' ? '[tool-result] ' : source === 'tool_definition' ? '[tool-def] ' : ''
    this.onBlock({
      stage: result.stage,
      score: result.score,
      similarity: result.similarity,
      target: meta.target,
      method: meta.method,
      path: meta.path,
      payload_preview: label + prompt.slice(0, 120 - label.length),
      payload_full: prompt,
      action: result.action === 'block' ? 'blocked' : 'warned',
      heuristicMatches: result.heuristicMatches,
      nearestTemplate: result.nearestTemplate,
      verdict: result.verdict,
      sandboxClient: meta.sandboxClient,
      isSandboxed: meta.isSandboxed,
      sandboxConfidence: meta.sandboxConfidence,
      kind: result.stage === 'rag' ? 'rag' : result.stage === 'ascii-smuggling' ? 'ascii-smuggling' : undefined,
      ragTag: result.ragTag,
      smuggleRanges: result.smuggleRanges,
    })
  }
}
