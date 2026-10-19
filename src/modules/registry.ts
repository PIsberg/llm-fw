import type { GatewayModule, GatewayModuleContext, ModuleResponse, ModuleStats } from './types.js'
import type { ModuleEvent, Config, ModulesConfig, ModuleSwitchConfig, HistoryWindowConfig, RepeatCollapseConfig, BlobElideConfig, LeanCtxConfig, ToolResultPrunerConfig, ToolResultDedupConfig, ToolResultTruncateConfig, ToolFilterConfig, ToolResultClearConfig, CacheControlConfig, ResponseCacheConfig } from '../types.js'
import type { CapturedResponse } from './responseTap.js'
import { HistoryWindowModule } from './builtin/historyWindow.js'
import { AnsiStripModule } from './builtin/ansiStrip.js'
import { ProgressCollapseModule } from './builtin/progressCollapse.js'
import { RepeatCollapseModule } from './builtin/repeatCollapse.js'
import { BlobElideModule } from './builtin/blobElide.js'
import { LeanCtxModule } from './builtin/leanCtx.js'
import { TokenPrunerModule } from './builtin/tokenPruner.js'
import { ToolResultPrunerModule } from './builtin/toolResultPruner.js'
import { ToolResultDedupModule } from './builtin/toolResultDedup.js'
import { ToolResultTruncateModule } from './builtin/toolResultTruncate.js'
import { ToolFilterModule } from './builtin/toolFilter.js'
import { ToolDefinitionPrunerModule } from './builtin/toolDefinitionPruner.js'
import { ToolUsageModule } from './builtin/toolUsage.js'
import { ToolResultClearModule } from './builtin/toolResultClear.js'
import { StreamUsageModule } from './builtin/streamUsage.js'
import { CacheControlModule } from './builtin/cacheControl.js'
import { ResponseCacheModule } from './builtin/responseCache.js'
import { UsageMeterModule } from './builtin/usageMeter.js'
import { DEFAULT_CONFIG } from '../config/config.js'
import { PayloadModule, parsePayload } from './base.js'
import { createLogger } from '../logger.js'

const log = createLogger('modules')

type BuiltinKey = Exclude<keyof ModulesConfig, 'enabled'>

// Built-in modules in pipeline order, each keyed by the `modules.<key>`
// object that holds its switch and options. The history window runs first,
// so the rest only work on turns that are kept (and dedup never points at a
// dropped one); content cleaners run before the whitespace pruners, so those
// see text without escape codes.
// `create` gets the module's own config object and the whole live modules
// config, for the one module that reads another's (Tool Usage names the
// tools the Tool Filter does not drop yet).
export const BUILTINS: Array<{ key: BuiltinKey; create: (cfg: ModuleSwitchConfig, modules: ModulesConfig) => GatewayModule }> = [
  { key: 'historyWindow', create: cfg => new HistoryWindowModule(cfg as HistoryWindowConfig) },
  { key: 'ansiStrip', create: cfg => new AnsiStripModule(cfg) },
  { key: 'progressCollapse', create: cfg => new ProgressCollapseModule(cfg) },
  { key: 'repeatCollapse', create: cfg => new RepeatCollapseModule(cfg as RepeatCollapseConfig) },
  { key: 'blobElide', create: cfg => new BlobElideModule(cfg as BlobElideConfig) },
  { key: 'leanCtx', create: cfg => new LeanCtxModule(cfg as LeanCtxConfig) },
  { key: 'tokenPruner', create: cfg => new TokenPrunerModule(cfg) },
  { key: 'toolResultPruner', create: cfg => new ToolResultPrunerModule(cfg as ToolResultPrunerConfig) },
  { key: 'toolResultDedup', create: cfg => new ToolResultDedupModule(cfg as ToolResultDedupConfig) },
  { key: 'toolResultTruncate', create: cfg => new ToolResultTruncateModule(cfg as ToolResultTruncateConfig) },
  { key: 'toolFilter', create: cfg => new ToolFilterModule(cfg as ToolFilterConfig) },
  { key: 'toolDefinitionPruner', create: cfg => new ToolDefinitionPrunerModule(cfg) },
  { key: 'toolUsage', create: (cfg, modules) => new ToolUsageModule(cfg, () => modules.toolFilter) },
  { key: 'toolResultClear', create: cfg => new ToolResultClearModule(cfg as ToolResultClearConfig) },
  { key: 'streamUsage', create: cfg => new StreamUsageModule(cfg) },
  { key: 'cacheControl', create: cfg => new CacheControlModule(cfg as CacheControlConfig) },
  { key: 'responseCache', create: cfg => new ResponseCacheModule(cfg as ResponseCacheConfig) },
  { key: 'usageMeter', create: cfg => new UsageMeterModule(cfg) },
]

/** One editable option of a built-in module, as the dashboard renders it. */
export interface ModuleOption {
  key: string
  type: 'boolean' | 'number' | 'string' | 'enum' | 'list'
  /** The live value. */
  value: unknown
  min?: number
  max?: number
  values?: string[]
}

// Bounds a dashboard edit must respect where the option's type alone is not
// enough: the module's own floor (a window of one message is no window), a
// ceiling that keeps a typo from pinning the process, and the enums. Keyed
// `<config key>.<option>`; an option without an entry takes its type's
// defaults (numbers: 0 to 1e9, integers).
const OPTION_RULES: Record<string, Pick<ModuleOption, 'min' | 'max' | 'values'>> = {
  'historyWindow.maxMessages': { min: 2, max: 100_000 },
  'historyWindow.step': { min: 1, max: 100_000 },
  'repeatCollapse.minRun': { min: 2, max: 1_000_000 },
  'blobElide.minLength': { min: 64, max: 100_000_000 },
  'toolResultDedup.minLength': { min: 1, max: 100_000_000 },
  'leanCtx.timeoutMs': { min: 1, max: 60_000 },
  'toolResultClear.triggerTokens': { min: 1 },
  'responseCache.ttlSeconds': { min: 1, max: 31_536_000 },
  'responseCache.maxEntries': { min: 1, max: 1_000_000 },
  'responseCache.maxEntryBytes': { min: 1, max: 1_073_741_824 },
  'cacheControl.ttl': { values: ['5m', '1h'] },
}
const NUMBER_MAX = 1_000_000_000
const STRING_MAX = 200
const LIST_MAX = 500

// Null when `value` is a valid `option`, else what is wrong with it.
function optionError(option: ModuleOption, value: unknown): string | null {
  const { key, type } = option
  switch (type) {
    case 'boolean':
      return typeof value === 'boolean' ? null : `${key} must be true or false`
    case 'number': {
      const min = option.min ?? 0
      const max = option.max ?? NUMBER_MAX
      if (typeof value !== 'number' || !Number.isInteger(value)) return `${key} must be a whole number`
      return value >= min && value <= max ? null : `${key} must be between ${min} and ${max}`
    }
    case 'enum':
      return typeof value === 'string' && option.values!.includes(value) ? null : `${key} must be one of ${option.values!.join(', ')}`
    case 'string':
      return typeof value === 'string' && value.length <= STRING_MAX ? null : `${key} must be a string of at most ${STRING_MAX} characters`
    case 'list':
      if (!Array.isArray(value) || value.length > LIST_MAX) return `${key} must be a list of at most ${LIST_MAX} names`
      return value.every(v => typeof v === 'string' && v.trim() !== '' && v.length <= STRING_MAX) ? null : `${key} must hold non-empty names of at most ${STRING_MAX} characters`
  }
}

export interface ModulesSummaryStats {
  totalTokensOriginal: number
  totalTokensPruned: number
  totalTokensSaved: number
  overallPercentSaved: number
  // The newest event's flag: false when it was an observe-mode dry run, so
  // the totals are what would have been saved. Absent before any event.
  applied?: boolean
}

/**
 * Token Economy is the parent of every module. Its switch is
 * `modules.enabled`, which the proxy and the gateway already check before
 * running any module; the modules' own switches are left alone, so turning it
 * back on restores exactly the set that ran before.
 */
export const TOKEN_ECONOMY_ID = 'token-economy'

export interface TokenEconomyStatus {
  id: typeof TOKEN_ECONOMY_ID
  name: 'Token Economy'
  enabled: boolean
}

export class ModuleManager {
  private modules = new Map<string, GatewayModule>()
  // The live modules config, so the parent switch writes where the proxy and
  // gateway read it. Absent for a manager built without a config.
  private economy: ModulesConfig | undefined
  // Module id to its `modules.<key>` config object, for the option editor.
  private readonly keys = new Map<string, BuiltinKey>()

  constructor(config?: Config, registerBuiltins = true) {
    this.economy = config?.modules
    if (registerBuiltins) {
      // Hand each module the live config sub-object, creating it from the
      // defaults if a caller's config predates it, so hot reload and the
      // dashboard toggle reach the running module (see PayloadModule.cfg).
      // Without a config, each module gets a private copy of its defaults.
      const defaults = DEFAULT_CONFIG.modules!
      const modules: ModulesConfig = config
        ? (config.modules ??= structuredClone(defaults))
        : structuredClone(defaults)
      this.economy = modules
      const slots = modules as unknown as Record<BuiltinKey, ModuleSwitchConfig | undefined>
      for (const { key, create } of BUILTINS) {
        const cfg = (slots[key] ??= structuredClone(defaults[key]) ?? { enabled: false })
        const mod = create(cfg, modules)
        this.keys.set(mod.id, key)
        this.register(mod)
      }
    }
  }

  /**
   * A response an enabled module serves in place of the provider's, or
   * undefined to forward. The first module that answers wins; one that
   * throws is logged and skipped, so the request is forwarded as usual.
   */
  respond(requestBody: string, ctx: GatewayModuleContext): ModuleResponse | undefined {
    for (const mod of this.modules.values()) {
      if (!mod.enabled || !mod.respond) continue
      try {
        const answer = mod.respond(requestBody, ctx)
        if (answer) return answer
      } catch (err) {
        log.error('module failed to answer a request; forwarding it', { module: mod.id, err })
      }
    }
    return undefined
  }

  /** True when an enabled module wants to see responses, so callers capture them. */
  wantsResponses(): boolean {
    for (const mod of this.modules.values()) {
      if (mod.enabled && mod.observeResponse) return true
    }
    return false
  }

  // Fails open like transformRequest: a module that throws is logged and the
  // others still see the response.
  observeResponse(requestBody: string, ctx: GatewayModuleContext, response: CapturedResponse): void {
    for (const mod of this.modules.values()) {
      if (!mod.enabled || !mod.observeResponse) continue
      try {
        mod.observeResponse(requestBody, ctx, response)
      } catch (err) {
        log.error('module failed on a response; ignored', { module: mod.id, err })
      }
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

  getTokenEconomy(): TokenEconomyStatus {
    return { id: TOKEN_ECONOMY_ID, name: 'Token Economy', enabled: this.economy?.enabled ?? false }
  }

  /**
   * Returns false when no module with that id is registered. The id
   * `token-economy` sets the parent switch.
   */
  setModuleEnabled(id: string, enabled: boolean): boolean {
    if (id === TOKEN_ECONOMY_ID) {
      if (!this.economy) return false
      this.economy.enabled = enabled
      return true
    }
    const mod = this.modules.get(id)
    if (!mod) return false
    mod.enabled = enabled
    return true
  }

  /**
   * The editable options of a module with their live values, derived from
   * the module's defaults in DEFAULT_CONFIG (every key but `enabled`) and
   * OPTION_RULES. Empty for a module without options or registered by hand;
   * undefined for an id that is not registered.
   */
  getModuleOptions(id: string): ModuleOption[] | undefined {
    const key = this.keys.get(id)
    if (!key || !this.economy) return this.modules.has(id) ? [] : undefined
    const defaults = (DEFAULT_CONFIG.modules![key] ?? {}) as Record<string, unknown>
    const live = ((this.economy as unknown as Record<string, unknown>)[key] ?? {}) as Record<string, unknown>
    return Object.entries(defaults).filter(([name]) => name !== 'enabled').map(([name, d]) => {
      const rule = OPTION_RULES[`${key}.${name}`] ?? {}
      const type: ModuleOption['type'] = rule.values ? 'enum' : Array.isArray(d) ? 'list' : typeof d === 'boolean' ? 'boolean' : typeof d === 'number' ? 'number' : 'string'
      return { key: name, type, value: live[name] ?? d, ...rule }
    })
  }

  /**
   * Validates every entry of `patch` against the module's options and, only
   * if all pass, writes them onto the live config object the module reads
   * (the same object hot reload writes), so the change applies to the next
   * request. Returns null, or what is wrong. The switch is not an option:
   * use setModuleEnabled.
   */
  setModuleOptions(id: string, patch: Record<string, unknown>): string | null {
    const options = this.getModuleOptions(id)
    if (!options) return `unknown module ${id}`
    const key = this.keys.get(id)
    const checked: Array<[string, unknown]> = []
    for (const [name, value] of Object.entries(patch)) {
      const option = options.find(o => o.key === name)
      if (!option) return name === 'enabled' ? 'enabled is the switch, not an option' : `unknown option ${name}`
      const error = optionError(option, value)
      if (error) return error
      checked.push([name, option.type === 'list' ? (value as string[]).map(v => v.trim()) : value])
    }
    if (!key || !this.economy) return checked.length === 0 ? null : `module ${id} has no options`
    const live = (this.economy as unknown as Record<string, Record<string, unknown>>)[key]!
    for (const [name, value] of checked) live[name] = value
    return null
  }

  // Fails open, like the judge: a module that throws or rejects is logged and
  // skipped, and the request continues with the body as the previous module
  // left it. A transformation is an optimisation, never a reason to drop a
  // request.
  //
  // Consecutive built-in payload modules share one parsed payload and one
  // serialisation (see PayloadModule.transformParsed). One of them that
  // throws may leave the slots it already rewrote rewritten: each rewrite is
  // a whole, valid replacement of one text field, so the body stays valid.
  async transformRequest(
    body: string,
    ctx: GatewayModuleContext
  ): Promise<{ body: string; modified: boolean; events: ModuleEvent[]; headers: Record<string, string> }> {
    let currentBody = body
    let anyModified = false
    const allEvents: ModuleEvent[] = []
    // Request headers the modules ask for upstream, the last word per name.
    // ctx.headers is replaced, never written to, so the modules after (and
    // respond) see the request as it will be sent while the caller's own
    // header object stays as the client sent it.
    const headers: Record<string, string> = {}
    // undefined: not parsed since the body last changed as a string; null:
    // not a JSON object, which payload modules pass through unchanged.
    let parsed: Record<string, unknown> | null | undefined
    let dirty = false
    const estimates = new Map<string, number>()
    const flush = (): void => {
      if (dirty && parsed) currentBody = JSON.stringify(parsed)
      dirty = false
    }

    for (const mod of this.modules.values()) {
      if (!mod.enabled) continue

      let result: { modified: boolean; body?: string; events?: ModuleEvent[] | undefined; headers?: Record<string, string> | undefined }
      try {
        if (mod instanceof PayloadModule) {
          if (parsed === undefined) parsed = parsePayload(currentBody)
          if (parsed === null) continue
          if (mod.prepare) await mod.prepare(parsed, ctx)
          result = mod.transformParsed(parsed, ctx, estimates)
          if (result.modified) dirty = true
        } else {
          flush()
          result = await mod.transformRequest(currentBody, ctx)
          if (result.modified && result.body !== undefined) {
            currentBody = result.body
            parsed = undefined
          }
        }
      } catch (err) {
        log.error('module failed; request continues without it', { module: mod.id, err })
        continue
      }
      if (result.modified) anyModified = true
      if (result.events && result.events.length > 0) {
        allEvents.push(...result.events)
      }
      if (result.headers && Object.keys(result.headers).length > 0) {
        Object.assign(headers, result.headers)
        ctx.headers = { ...ctx.headers, ...result.headers }
        anyModified = true
      }
    }
    flush()

    return {
      body: currentBody,
      modified: anyModified,
      events: allEvents,
      headers,
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
