// Task C6 — documented programmatic scan API.
//
// Lets a Node.js app call the detection pipeline directly, in-process, without
// running the proxy/TLS/dashboard at all: `const fw = await createFirewall();
// const verdict = await fw.scan({ text })`. This is the "library" integration
// path; the proxy (see README "Quick Start") remains the zero-integration path
// for anything that merely needs its outbound HTTPS traffic inspected.
//
// Design notes:
//   - Config layering mirrors every other entrypoint (proxy/CLI/dashboard):
//     loadConfig() resolves DEFAULT_CONFIG + project config file +
//     ~/.llm-fw/config.json + LLM_FW_* env vars, and the caller's `config`
//     argument deep-merges on top of that as the final, most-specific layer.
//   - `scan({ text, surface })` synthesizes the minimal Anthropic /v1/messages
//     envelope Pipeline.run() needs — mirroring how the dashboard playground's
//     POST /api/test builds a body for free-typed text (src/dashboard/server.ts)
//     — so the full extraction/candidate/threshold logic runs unmodified.
//     `scan({ body, path })` is the escape hatch for any wire format a
//     bundled parser already understands (OpenAI, Gemini, Bedrock, …).
//   - Pipeline.emit() reports events through a single per-instance onBlock
//     callback, but scan() calls may run concurrently on one Firewall
//     instance (e.g. concurrent requests in an HTTP handler). AsyncLocalStorage
//     scopes each call's events to that call — including across the `await`
//     points inside Pipeline.run() — so concurrent scans never cross-pollute
//     each other's `events` array.
import { AsyncLocalStorage } from 'node:async_hooks'
import { Pipeline, ScanSource } from './detection/pipeline.js'
import { loadConfig, deepMerge } from './config/config.js'
import type { Config, BlockEvent } from './types.js'

export type { ScanSource }

/** Every key at every depth of `T` becomes optional — recursively. */
export type DeepPartial<T> = T extends (infer U)[]
  ? DeepPartial<U>[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T

export interface ScanInput {
  /**
   * Raw text to scan, e.g. a user prompt, a tool result, or retrieved
   * document text. Synthesized into an Anthropic-shaped request body
   * (requestPath is always '/v1/messages' for this field — use `body` +
   * `path` if you need a different provider's wire format). Ignored if
   * `body` is also set.
   */
  text?: string
  /**
   * A complete, already-serialized API request body (JSON string) in any
   * format a bundled parser understands (Anthropic /v1/messages, OpenAI
   * chat/completions, Gemini, Bedrock, …). Takes precedence over `text`.
   */
  body?: string
  /**
   * Which parser to use for `body` (defaults to '/v1/messages', the
   * Anthropic Messages format). Has no effect on `text` scans, which always
   * synthesize an Anthropic-shaped envelope.
   */
  path?: string
  /**
   * Provenance to tag a `text` scan with — mirrors the surfaces the proxy
   * itself distinguishes (see ScanSource in src/detection/pipeline.ts).
   * Defaults to 'prompt' (a direct user message). Note: 'document' scanning
   * only takes effect when the resolved config has `nonText.enabled: true`
   * (default false) — same as it does for real traffic through the proxy.
   */
  surface?: ScanSource
}

export interface ScanVerdict {
  action: 'pass' | 'warn' | 'block'
  stage: string
  score: number
  similarity: number
  /** Dashboard-style audit events emitted while scanning this input (0, 1, or 2 — e.g. an opaque-media warn plus a separate content warn). */
  events: Omit<BlockEvent, 'id' | 'timestamp'>[]
}

export interface Firewall {
  scan(input: ScanInput): Promise<ScanVerdict>
  /** Releases any resources the firewall holds (Task C3's worker-thread inference, if enabled). Safe to call even if nothing was ever spawned. */
  close(): Promise<void>
}

const DEFAULT_PATH = '/v1/messages'
const PLACEHOLDER_MODEL = 'claude-3-haiku-20240307'

/** Mirrors the dashboard playground's free-typed-text envelope (src/dashboard/server.ts POST /api/test). */
function wrapText(text: string, surface: ScanSource): string {
  switch (surface) {
    case 'system':
      return JSON.stringify({
        model: PLACEHOLDER_MODEL,
        max_tokens: 1,
        system: text,
        messages: [{ role: 'user', content: '.' }],
      })
    case 'tool_result':
      return JSON.stringify({
        model: PLACEHOLDER_MODEL,
        max_tokens: 1,
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_scan', name: 'tool', input: {} }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_scan', content: text }] },
        ],
      })
    case 'tool_definition':
      return JSON.stringify({
        model: PLACEHOLDER_MODEL,
        max_tokens: 1,
        messages: [{ role: 'user', content: '.' }],
        tools: [{ name: 'scanned_tool', description: text }],
      })
    case 'document':
      return JSON.stringify({
        model: PLACEHOLDER_MODEL,
        max_tokens: 1,
        messages: [{
          role: 'user',
          content: [{ type: 'document', source: { type: 'base64', media_type: 'text/plain', data: Buffer.from(text, 'utf-8').toString('base64') } }],
        }],
      })
    case 'prompt':
    default:
      return JSON.stringify({ model: PLACEHOLDER_MODEL, max_tokens: 1, messages: [{ role: 'user', content: text }] })
  }
}

/**
 * Build an in-process firewall: init the same detection Pipeline the proxy
 * and dashboard use, with no proxy/TLS/dashboard server started. `config`
 * deep-merges over the fully-resolved config (defaults + project file +
 * ~/.llm-fw/config.json + env vars) as the final override layer — e.g.
 * `createFirewall({ detection: { judgeEnabled: true } })`.
 */
export async function createFirewall(config?: DeepPartial<Config>): Promise<Firewall> {
  const base = await loadConfig()
  // deepMerge recurses into nested plain objects regardless of how deep the
  // source layer's keys go, so a DeepPartial input is safe here at runtime;
  // the cast bridges the gap between deepMerge's Partial<T> signature (which
  // is only shallow-optional at the type level) and our deep-partial input.
  const resolved = config ? deepMerge<Config>(base, config as Partial<Config>) : base

  const events = new AsyncLocalStorage<Omit<BlockEvent, 'id' | 'timestamp'>[]>()
  const pipeline = new Pipeline(resolved, event => { events.getStore()?.push(event) })
  await pipeline.init()

  return {
    async scan(input: ScanInput): Promise<ScanVerdict> {
      if (input.body === undefined && input.text === undefined) {
        throw new Error('createFirewall().scan() requires either `text` or `body`')
      }
      const surface = input.surface ?? 'prompt'
      const requestPath = input.body !== undefined ? (input.path ?? DEFAULT_PATH) : DEFAULT_PATH
      const body = input.body !== undefined ? input.body : wrapText(input.text ?? '', surface)

      const collected: Omit<BlockEvent, 'id' | 'timestamp'>[] = []
      const result = await events.run(collected, () => pipeline.run(
        requestPath,
        body,
        { target: 'library', method: 'POST', path: requestPath }
      ))

      return {
        action: result.action,
        stage: result.stage,
        score: result.score,
        similarity: result.similarity,
        events: collected,
      }
    },
    async close(): Promise<void> {
      await pipeline.close()
    },
  }
}
