import type { GatewayModule, GatewayModuleContext, ModuleTransformResult, ModuleStats } from './types.js'
import type { ModuleEvent } from '../types.js'
import { collectTextSlots, type SlotKind, type TextSlot } from './payload.js'
import { estimateTokens } from './tokens.js'

/** A JSON body parsed to an object, or null when it is not one. */
export function parsePayload(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/**
 * estimateTokens through a per-request memo. Modules of one request see the
 * same string objects until one rewrites them, so the second module's lookup
 * is a hash hit instead of another pass over the text.
 */
export function estimate(text: string, estimates: Map<string, number>): number {
  if (text.length < 256) return estimateTokens(text)
  let n = estimates.get(text)
  if (n === undefined) {
    n = estimateTokens(text)
    estimates.set(text, n)
  }
  return n
}

/** The switch every built-in module reads; extended with module options. */
export interface ModuleSwitch {
  enabled: boolean
}

/** What a module did to one parsed request. */
export interface PayloadOutcome {
  changed: boolean
  /** Prompt-text tokens examined, and what is left of them afterwards. */
  tokensOriginal: number
  tokensPruned: number
}

/**
 * A module that parses the JSON request body, rewrites the parsed payload and
 * serialises it again. Owns the enabled switch, the running totals and the
 * dashboard events, so a subclass only says what it does to a payload.
 */
export abstract class PayloadModule<C extends ModuleSwitch = ModuleSwitch> implements GatewayModule {
  abstract readonly id: string
  abstract readonly name: string
  abstract readonly description: string

  // A reference to the live config object, never a copy: hot reload writes
  // leaf values onto the object it already holds (see setPath in
  // src/config/hotReload.ts), and the dashboard persists config, so both see
  // one source of truth.
  protected readonly cfg: C

  private totalInvocations = 0
  private tokensOriginal = 0
  private tokensPruned = 0
  private tokensSaved = 0
  private recentEvents: ModuleEvent[] = []

  constructor(config: C) {
    this.cfg = config
  }

  get enabled(): boolean {
    return this.cfg.enabled
  }

  set enabled(value: boolean) {
    this.cfg.enabled = value
  }

  /**
   * Rewrite `payload` in place. Return null when the request is not one this
   * module handles. Count tokens through `estimate(text, estimates)`.
   */
  protected abstract apply(payload: Record<string, unknown>, ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome | null

  getStats(): ModuleStats {
    const percentSaved = this.tokensOriginal > 0
      ? (this.tokensSaved / this.tokensOriginal) * 100
      : 0
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.totalInvocations,
      tokensOriginal: this.tokensOriginal,
      tokensPruned: this.tokensPruned,
      tokensSaved: this.tokensSaved,
      percentSaved: Math.round(percentSaved * 10) / 10,
      recentEvents: [...this.recentEvents],
    }
  }

  resetStats(): void {
    this.totalInvocations = 0
    this.tokensOriginal = 0
    this.tokensPruned = 0
    this.tokensSaved = 0
    this.recentEvents = []
  }

  transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
    if (!this.enabled) {
      return { body, modified: false }
    }
    const parsed = parsePayload(body)
    if (!parsed) return { body, modified: false }
    const result = this.transformParsed(parsed, ctx, new Map())
    return result.modified ? { ...result, body: JSON.stringify(parsed) } : { body, modified: false }
  }

  /**
   * The rewrite on an already parsed payload, in place. ModuleManager calls
   * this directly so a run of payload modules shares one JSON.parse and one
   * JSON.stringify per request instead of one each; `estimates` is shared
   * across them for the same reason. Every module re-parsing and estimating
   * on its own cost 414 ms per request on a 1.95 MB agent body with all of
   * them on.
   */
  transformParsed(payload: Record<string, unknown>, ctx: GatewayModuleContext, estimates: Map<string, number>): Omit<ModuleTransformResult, 'body'> {
    const outcome = this.apply(payload, ctx, estimates)
    if (!outcome) return { modified: false }
    const { tokensOriginal, tokensPruned } = outcome

    // Totals cover every request with prompt text, including the ones with
    // nothing to change, so the overall percentage is over all text examined.
    const tokensSaved = Math.max(0, tokensOriginal - tokensPruned)
    if (tokensOriginal > 0) {
      this.totalInvocations++
      this.tokensOriginal += tokensOriginal
      this.tokensPruned += tokensPruned
      this.tokensSaved += tokensSaved
    }

    if (!outcome.changed) {
      return { modified: false }
    }

    // A change to no prompt text (a cache marker) has no saving to report.
    if (tokensOriginal === 0 && tokensPruned === 0) return { modified: true }
    const percentSaved = tokensOriginal > 0 ? (tokensSaved / tokensOriginal) * 100 : 0
    const event = this.event(ctx, tokensOriginal, tokensPruned, tokensSaved, percentSaved)

    return {
      modified: true,
      metadata: {
        tokensOriginal,
        tokensPruned,
        tokensSaved,
        percentSaved,
      },
      events: [event],
    }
  }

  protected event(ctx: GatewayModuleContext, tokensOriginal: number, tokensPruned: number, tokensSaved: number, percentSaved: number): ModuleEvent {
    const overallPercentSaved = this.tokensOriginal > 0
      ? (this.tokensSaved / this.tokensOriginal) * 100
      : 0

    const event: ModuleEvent = {
      id: `mod-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      moduleId: this.id,
      moduleName: this.name,
      target: ctx.target,
      path: ctx.path,
      tokensOriginal,
      tokensPruned,
      tokensSaved,
      percentSaved: Math.round(percentSaved * 10) / 10,
      totalTokensSaved: this.tokensSaved,
      overallPercentSaved: Math.round(overallPercentSaved * 10) / 10,
      applied: !ctx.dryRun,
    }

    this.recentEvents.unshift(event)
    if (this.recentEvents.length > 50) this.recentEvents.pop()
    return event
  }
}

/**
 * A module that rewrites text slots of chosen kinds one at a time. Savings
 * are counted on the slot text, not on the request body: re-serialising a
 * pretty-printed JSON envelope shrinks the body by bytes the model never sees
 * as tokens.
 *
 * A rewrite must be a function of the slot and of the slots before it, never
 * of time, position from the end, or anything outside the request. The same
 * history then comes out byte-identical on every turn, which is what keeps
 * the provider's prompt cache warm and a thinking block's signature valid.
 */
export abstract class SlotModule<C extends ModuleSwitch = ModuleSwitch> extends PayloadModule<C> {
  protected abstract readonly kinds: ReadonlySet<SlotKind>

  /** Rewrite one slot's text. Called in render order. */
  protected abstract rewrite(text: string, slot: TextSlot): string

  /** Reset per-request state before the first rewrite. */
  protected beginRequest(): void {}

  protected apply(payload: Record<string, unknown>, _ctx: GatewayModuleContext, estimates: Map<string, number>): PayloadOutcome {
    this.beginRequest()
    let changed = false
    let tokensOriginal = 0
    let tokensPruned = 0
    for (const slot of collectTextSlots(payload)) {
      if (!this.kinds.has(slot.kind)) continue
      const before = slot.text
      const after = this.rewrite(before, slot)
      const was = estimate(before, estimates)
      tokensOriginal += was
      tokensPruned += after === before ? was : estimate(after, estimates)
      if (after !== before) {
        slot.set(after)
        changed = true
      }
    }
    return { changed, tokensOriginal, tokensPruned }
  }
}
