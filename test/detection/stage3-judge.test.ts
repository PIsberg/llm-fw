/**
 * Stage 3 (judge) coverage gate.
 *
 * The cheap stages — heuristic (Stage 1) and embedding similarity (Stage 2) —
 * catch attacks whose WORDING resembles known patterns. The whole reason Stage 3
 * (the local Ollama judge) exists is to catch attacks the cheap stages miss: a
 * well-worded jailbreak that carries no trigger phrases and sits below the
 * embedding block threshold, but whose INTENT a reasoning model still recognizes.
 *
 * This fixture holds one such example per injection class. Each is hand-tuned so
 * that, per example, BOTH hold:
 *   • judge OFF  → the pipeline does NOT block it (it slips past Stages 1 & 2,
 *                  proving it genuinely reaches Stage 3 rather than being caught
 *                  early);
 *   • judge ON   → the pipeline blocks it at `stage: 'judge'` (the model
 *                  recognizes the intent).
 *
 * These prompts deliberately EVADE the cheap stages, so they must NOT live in the
 * judge-off corpora (test/detection/fixtures/corpus.json,
 * test/load/data/malicious.json) — there they would register as misses and break
 * those gates' recall floors. They belong here, behind a live judge.
 *
 * Requires a running Ollama with a usable model. CI has neither, so the suite
 * SKIPS when Ollama is unreachable — it is a local/opt-in gate, never a CI
 * blocker. The judge runs at temperature 0, so a given model's verdicts are
 * effectively deterministic; the prompts are unambiguous jailbreaks that any
 * competent judge model should flag. Point at a specific model with
 * LLM_FW_JUDGE_MODEL (defaults to the first model the local Ollama reports).
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

const __dir = dirname(fileURLToPath(import.meta.url))
const corpus = JSON.parse(
  readFileSync(join(__dir, 'fixtures', 'stage3-corpus.json'), 'utf8'),
) as { class: string; prompt: string }[]

const OLLAMA = 'http://localhost:11434'

// Resolve a judge model the local Ollama actually has, or null if Ollama is
// down / empty. Honours LLM_FW_JUDGE_MODEL when that tag is present.
async function resolveJudgeModel(): Promise<string | null> {
  try {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) })
    if (!res.ok) return null
    const { models } = (await res.json()) as { models?: { name: string }[] }
    const names = (models ?? []).map((m) => m.name)
    if (names.length === 0) return null
    const wanted = process.env.LLM_FW_JUDGE_MODEL
    if (wanted && names.includes(wanted)) return wanted
    return names[0]
  } catch {
    return null
  }
}

const body = (text: string) =>
  JSON.stringify({ model: 'claude-3-haiku-20240307', messages: [{ role: 'user', content: text }], max_tokens: 1 })

const meta = { target: 'stage3', method: 'POST', path: '/v1/messages' }

describe('Stage 3 judge coverage', async () => {
  const judgeModel = await resolveJudgeModel()
  const describeOrSkip = judgeModel ? describe : describe.skip

  if (!judgeModel) {
    it.skip('Ollama unavailable — Stage 3 coverage skipped (set up Ollama to run)', () => {})
    return
  }

  // Two pipelines sharing the (expensive) embedding model load: one with the
  // judge off (to prove the example reaches Stage 3) and one with it on in sync
  // block mode (to prove Stage 3 catches it).
  let cheap: Pipeline
  let withJudge: Pipeline

  beforeAll(async () => {
    const cheapCfg = structuredClone(DEFAULT_CONFIG) as Config
    cheapCfg.detection.judgeEnabled = false

    const judgeCfg = structuredClone(DEFAULT_CONFIG) as Config
    judgeCfg.detection.judgeEnabled = true
    judgeCfg.detection.judgeBlock = true // sync, so the verdict drives the result
    judgeCfg.detection.judgeUnlessBenign = true // judge anything not confidently benign
    judgeCfg.detection.judgeModel = judgeModel as string

    cheap = new Pipeline(cheapCfg)
    withJudge = new Pipeline(judgeCfg)
    await Promise.all([cheap.init(), withJudge.init()])
  }, 180_000)

  describeOrSkip(`against ${judgeModel}`, () => {
    it.each(corpus)('[$class] slips past cheap stages but is blocked at Stage 3', async ({ prompt }) => {
      // Judge off: the cheap stages must NOT block — otherwise it never reaches
      // Stage 3 and belongs in the judge-off corpus instead.
      const cheapResult = await cheap.run('/v1/messages', body(prompt), meta)
      expect(cheapResult.action, 'should pass Stages 1 & 2 with judge off').not.toBe('block')

      // Judge on: the model recognizes the intent and the pipeline blocks at the
      // judge stage.
      const judgedResult = await withJudge.run('/v1/messages', body(prompt), meta)
      expect(judgedResult.action, 'judge should block').toBe('block')
      expect(judgedResult.stage, 'block must come from Stage 3').toBe('judge')
    }, 60_000)
  })
})
