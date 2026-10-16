import type { GatewayModule, GatewayModuleContext, ModuleStats } from './types.js'
import type { ModuleEvent, Config, TokenPrunerConfig } from '../types.js'
import { TokenPrunerModule } from './builtin/tokenPruner.js'
import { createLogger } from '../logger.js'

const log = createLogger('modules')

export interface ModulesSummaryStats {
  totalTokensOriginal: number
  totalTokensPruned: number
  totalTokensSaved: number
  overallPercentSaved: number
  // The newest event's flag: false when it was an observe-mode dry run, so
  // the totals are what would have been saved. Absent before any event.
  applied?: boolean
}

export class ModuleManager {
  private modules = new Map<string, GatewayModule>()

  constructor(config?: Config, registerBuiltins = true) {
    if (registerBuiltins) {
      // Hand the module the live config sub-object, creating it if a caller's
      // config predates modules, so hot reload and the dashboard toggle reach
      // it (see TokenPrunerModule.cfg).
      let prunerConfig: TokenPrunerConfig | undefined
      if (config) {
        const modules = (config.modules ??= { enabled: true, tokenPruner: { enabled: false } })
        prunerConfig = (modules.tokenPruner ??= { enabled: false })
      }
      this.register(new TokenPrunerModule(prunerConfig))
    }
  }

  register(module: GatewayModule): void {
    this.modules.set(module.id, module)
  }

  getModule(id: string): GatewayModule | undefined {
    return this.modules.get(id)
  }

  listModules(): GatewayModule[] {
    return Array.from(this.modules.values())
  }

  /** Returns false when no module with that id is registered. */
  setModuleEnabled(id: string, enabled: boolean): boolean {
    const mod = this.modules.get(id)
    if (!mod) return false
    mod.enabled = enabled
    return true
  }

  // Fails open, like the judge: a module that throws or rejects is logged and
  // skipped, and the request continues with the body as the previous module
  // left it. A transformation is an optimisation, never a reason to drop a
  // request.
  async transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<{ body: string; modified: boolean; events: ModuleEvent[] }> {
    let currentBody = body
    let anyModified = false
    const allEvents: ModuleEvent[] = []

    for (const mod of this.modules.values()) {
      if (!mod.enabled) continue

      let result
      try {
        result = await mod.transformRequest(currentBody, ctx)
      } catch (err) {
        log.error('module failed; request continues without it', { module: mod.id, err })
        continue
      }
      if (result.modified) {
        currentBody = result.body
        anyModified = true
      }
      if (result.events && result.events.length > 0) {
        allEvents.push(...result.events)
      }
    }

    return {
      body: currentBody,
      modified: anyModified,
      events: allEvents,
    }
  }

  getSummaryStats(): ModulesSummaryStats {
    let totalTokensOriginal = 0
    let totalTokensPruned = 0
    let totalTokensSaved = 0
    let latest: ModuleEvent | undefined

    for (const mod of this.modules.values()) {
      const stats: ModuleStats = mod.getStats()
      totalTokensOriginal += stats.tokensOriginal
      totalTokensPruned += stats.tokensPruned
      totalTokensSaved += stats.tokensSaved
      // recentEvents is newest first
      const newest = stats.recentEvents[0]
      if (newest && (!latest || newest.timestamp > latest.timestamp)) latest = newest
    }

    const overallPercentSaved = totalTokensOriginal > 0
      ? Math.round(((totalTokensSaved / totalTokensOriginal) * 100) * 10) / 10
      : 0

    return {
      totalTokensOriginal,
      totalTokensPruned,
      totalTokensSaved,
      overallPercentSaved,
      ...(latest?.applied === undefined ? {} : { applied: latest.applied }),
    }
  }
}
