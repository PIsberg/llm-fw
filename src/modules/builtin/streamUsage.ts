import type { ModuleSwitchConfig } from '../../types.js'
import type { GatewayModuleContext, ModuleStats } from '../types.js'
import { PayloadModule, type PayloadOutcome } from '../base.js'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * An OpenAI chat completions stream reports its usage only when the client
 * asks with `stream_options.include_usage`, and most clients do not, so the
 * usage meter could not meter those streams. This sets it on every streaming
 * chat completions request that does not, on any host that serves that path
 * (OpenAI, Azure OpenAI, Groq, Together and the other compatible APIs).
 *
 * The client receives one more chunk at the end of the stream, with an empty
 * `choices` array and the `usage` object, which is why it is opt-in: a client
 * that reads `chunk.choices[0]` without checking gets `undefined` there. The
 * official SDKs document that chunk. Touches no message text, so the prompt
 * cache and the request prefix are unaffected.
 */
export class StreamUsageModule extends PayloadModule<ModuleSwitchConfig> {
  readonly id = 'stream-usage'
  readonly name = 'Stream Usage Reporter'
  readonly description = 'Asks OpenAI-style chat completions streams to report their token usage, so the usage meter can count them'

  private marked = 0
  private wouldMark = 0
  private clientManaged = 0

  constructor(config?: ModuleSwitchConfig) {
    super(config ?? { enabled: false })
  }

  protected apply(payload: Obj, ctx: GatewayModuleContext): PayloadOutcome | null {
    const path = ctx.path.split('?')[0] ?? ''
    if (!path.endsWith('/chat/completions') || payload.stream !== true || !Array.isArray(payload.messages)) return null
    const options = payload.stream_options
    if (options !== undefined && !isObj(options)) return null
    if (options?.include_usage === true) {
      this.clientManaged++
      return null
    }
    payload.stream_options = { ...options, include_usage: true }
    if (ctx.dryRun) this.wouldMark++
    else this.marked++
    return { changed: true, tokensOriginal: 0, tokensPruned: 0 }
  }

  getStats(): ModuleStats {
    return {
      ...super.getStats(),
      kpis: [
        { key: 'marked', label: 'Streams asked to report usage', value: this.marked },
        { key: 'wouldMark', label: 'Would ask (observe mode)', value: this.wouldMark },
        { key: 'clientManaged', label: 'Client already asks', value: this.clientManaged },
      ],
    }
  }

  resetStats(): void {
    super.resetStats()
    this.marked = 0
    this.wouldMark = 0
    this.clientManaged = 0
  }
}
