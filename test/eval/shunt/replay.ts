import type { Config } from '../../../src/types.js'

// STUB for T022. The exports and signatures below are what test/eval/shuntReplay.test.ts
// (T021) drives; every body throws until T022 implements it. The field names of
// `ReplayReport` that T022 does not spell out (`seen`, `eligible`, `condensed`,
// `originalTokens`, `condensedTokens`, `reduction`, `shareSaved`,
// `keyFactRetention`) were chosen by the tests and are defined here, with the
// formulas they assert. T022 also adds `main()` and the `eval:shunt:replay`
// script; neither is part of this stub.

/** One tool result of a recorded session, paired with the call that made it. */
export interface ReplayItem {
  name: string
  input: unknown
  text: string
  /**
   * Distinct assistant `message.id`s after the result's line and before the
   * next `"subtype":"compact_boundary"` entry of the same file, less the first,
   * which reads the result as new input (plan Design 9). Never negative.
   */
  rereads: number
}

/** Pairs each `tool_result` of a Claude Code transcript with the `tool_use` of the same id. */
export function pairToolResults(_jsonl: string): ReplayItem[] {
  throw new Error('not implemented: pairToolResults (T022)')
}

/** The key facts of D6 that a rule-based extractor finds in an original tool result. */
export function extractKeyFacts(_original: string): string[] {
  throw new Error('not implemented: extractKeyFacts (T022)')
}

export type ScreenVerdict = 'clean' | 'flagged' | 'unscanned'

/** Detection and DLP over one result, as the proxy runs them before the module acts (FR-012). */
export function detectionScreen(_config: Config): (item: ReplayItem) => Promise<ScreenVerdict> {
  throw new Error('not implemented: detectionScreen (T022)')
}

/** The figures of US5-1, computed per plan Design 9. Token counts come from `opts.countTokens` on LF-normalised text. */
export interface ReplayReport {
  /** A sentence saying that only results the module would condense were counted. */
  scope: string
  tokenizer: string
  /** `opts.worker.model`. */
  workerModel: string
  sampleSessions: number
  date: string
  /** `opts.includeFileReads`. */
  fileReadsIncluded: boolean

  /** Tool results in `items`, whatever their tool or size. */
  seen: number
  /** Results that pass `eligibility` and that `screen` calls `'clean'`: the ones the worker is asked about. */
  eligible: number
  /** Eligible results the worker condensed and whose original is stored. */
  condensed: number
  /** Eligible results with a `worker-failed` outcome, a timeout included. */
  workerFailed: number
  /** Eligible results whose worker answer the citation or size check rejected. */
  rejected: number
  /** Results that pass `eligibility` but that `screen` calls `'flagged'` or `'unscanned'`. Never sent to the worker. */
  excluded: { flagged: number; unscanned: number }

  /** Sum of `countTokens(original)` over the eligible results. */
  originalTokens: number
  /** Sum of `countTokens(condensed result as forwarded)` over the condensed results. */
  condensedTokens: number
  /** `1 - condensedTokens / (original tokens of the condensed results)`, a fraction; 0 with nothing condensed. */
  reduction: number
  /** `tokensAvoided / countTokens of every seen result`, a fraction. */
  shareSaved: number

  /** Sum over condensed results of `countTokens(original) - countTokens(condensed result as forwarded)`. */
  tokensAvoided: number
  /** Sum of that difference times `(1.25 + 0.1 * rereads)`. */
  billWeighted: number
  /** `tokensIn` of every answered worker call (rejected ones included) plus `read` of a `partial-input` failure. */
  workerIn: number
  /** `tokensOut` of every answered worker call, rejected ones included. */
  workerOut: number
  /** `tokensAvoided - (workerIn + workerOut)`. */
  netTokensAvoided: number
  /** `billWeighted - (workerIn + workerOut)`. */
  netBillWeighted: number

  /** Condensed results whose original has at least one key fact (`extractKeyFacts`). */
  labelledSubset: number
  /** Key facts that appear in the condensed result, over the labelled subset; null when it is empty. */
  keyFactRetention: number | null
}

export interface ReplayOptions {
  worker: { url: string; model: string }
  countTokens: (text: string) => number
  includeFileReads: boolean
  screen: (item: ReplayItem) => Promise<ScreenVerdict>
  /** Wait limit per worker call, ms; 15,000 (the live limit of FR-008) when absent. */
  waitMs?: number
}

export async function replay(_items: ReplayItem[], _opts: ReplayOptions): Promise<ReplayReport> {
  throw new Error('not implemented: replay (T022)')
}
