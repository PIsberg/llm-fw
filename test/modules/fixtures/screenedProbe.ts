import { randomUUID } from 'node:crypto'
import type { GatewayModule, GatewayModuleContext, ModuleResponse, ModuleStats, ModuleTransformResult } from '../../../src/modules/types.js'
import type { CapturedResponse } from '../../../src/modules/responseTap.js'
import type { ModuleEvent } from '../../../src/types.js'
import type { Screening } from '../../../src/modules/screening.js'
import { collectTextSlots } from '../../../src/modules/payload.js'

// A stand-in for a module that runs after detection and DLP (`afterScreening`),
// for the proxy and gateway end-to-end suites: it records everything the
// listener hands a post-screening module and rewrites the body as a test
// scripts it. specs/001-tool-result-shunt/data-model.md "Screening record" and
// plan Design 1 and 2 are what the listeners owe it.

export const PROBE_ID = 'e2e-screened-probe'
/** The field `markBody` adds, so the forwarded body shows the probe's rewrite. */
export const PROBE_FIELD = 'llm_fw_probe'

/** What one `transformRequest` call on the probe was given. */
export interface ProbeCall {
  body: string
  screening: Screening | undefined
  remoteAddress: string | undefined
  dryRun: boolean | undefined
}

/** Adds a marker field to the JSON body, so it stays valid JSON and is plainly not the screened body. */
export const markBody = (body: string): string =>
  JSON.stringify({ ...(JSON.parse(body) as Record<string, unknown>), [PROBE_FIELD]: 'screened' })

/** Replaces every tool result's text with a few characters, as a module that condenses them would. */
export const shrinkToolResults = (body: string): string => {
  const payload = JSON.parse(body) as unknown
  for (const slot of collectTextSlots(payload)) if (slot.kind === 'tool_result') slot.set('[shrunk]')
  return JSON.stringify(payload)
}

export class ScreenedProbe implements GatewayModule {
  readonly id = PROBE_ID
  readonly name = 'E2E Screened Probe'
  readonly description = 'Records what a module that runs after detection and DLP is given, and rewrites the body'
  readonly afterScreening = true
  enabled = false

  /** How the probe rewrites the body it is given; `markBody` unless a test says otherwise. */
  rewrite: (body: string) => string = markBody

  /** Every `transformRequest` call, in order. */
  seen: ProbeCall[] = []
  /** The module event each call returned, in order. */
  emitted: ModuleEvent[] = []
  /** The `requestBody` of every `respond` call: the body that would go upstream. */
  answered: string[] = []
  /** The `requestBody` of every `observeResponse` call: the body that went upstream. */
  observed: string[] = []

  transformRequest(body: string, ctx: GatewayModuleContext): ModuleTransformResult {
    this.seen.push({ body, screening: ctx.screening, remoteAddress: ctx.remoteAddress, dryRun: ctx.dryRun })
    const out = this.rewrite(body)
    const event: ModuleEvent = {
      id: `probe-${randomUUID()}`,
      timestamp: new Date().toISOString(),
      moduleId: this.id,
      moduleName: this.name,
      target: ctx.target,
      path: ctx.path,
      tokensOriginal: body.length,
      tokensPruned: out.length,
      tokensSaved: Math.max(0, body.length - out.length),
      percentSaved: 0,
      totalTokensSaved: 0,
      overallPercentSaved: 0,
      applied: !ctx.dryRun,
    }
    this.emitted.push(event)
    return { body: out, modified: out !== body, events: [event] }
  }

  respond(requestBody: string): ModuleResponse | undefined {
    this.answered.push(requestBody)
    return undefined
  }

  observeResponse(requestBody: string, _ctx: GatewayModuleContext, _response: CapturedResponse): void {
    this.observed.push(requestBody)
  }

  getStats(): ModuleStats {
    return {
      id: this.id,
      name: this.name,
      enabled: this.enabled,
      totalInvocations: this.seen.length,
      tokensOriginal: 0,
      tokensPruned: 0,
      tokensSaved: 0,
      percentSaved: 0,
      recentEvents: [],
    }
  }

  /** Forget every recorded call and go back to marking the body. */
  reset(): void {
    this.seen = []
    this.emitted = []
    this.answered = []
    this.observed = []
    this.rewrite = markBody
  }
}
