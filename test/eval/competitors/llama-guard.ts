import type { CompetitorAdapter } from './adapter.js'

const DEFAULT_MODEL = 'llama-guard3'

/**
 * Meta Llama Guard 3 via a local Ollama instance.
 *
 * Only runs when Ollama is reachable AND the model tag is already pulled —
 * this adapter never triggers a multi-GB `ollama pull` itself (mirrors
 * src/detection/judge.ts's isAvailable() reachability probe, plus a model-
 * list check since a reachable Ollama with a different model set is the
 * common case on a dev machine).
 */
export class LlamaGuardAdapter implements CompetitorAdapter {
  name: string
  private reason: string | undefined

  constructor(
    private baseUrl = process.env.LLM_FW_OLLAMA_URL || 'http://localhost:11434',
    private model = DEFAULT_MODEL,
  ) {
    this.name = `llama-guard-3 (ollama:${this.model})`
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(2000) })
      if (!res.ok) {
        this.reason = `not run: Ollama unreachable (HTTP ${res.status})`
        return false
      }
      const data = await res.json() as { models?: { name: string }[] }
      const pulled = data.models?.some(m => m.name === this.model || m.name.startsWith(`${this.model}:`)) ?? false
      if (!pulled) {
        this.reason = `not run: Ollama reachable but ${this.model} is not pulled (run \`ollama pull ${this.model}\`)`
        return false
      }
      return true
    } catch (err) {
      this.reason = `not run: Ollama unreachable (${(err as Error).message})`
      return false
    }
  }

  skipReason(): string | undefined {
    return this.reason
  }

  async classify(text: string): Promise<{ injection: boolean; score?: number }> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'user', content: text }],
        stream: false,
      }),
    })
    if (!res.ok) throw new Error(`llama-guard: HTTP ${res.status}`)
    const data = await res.json() as { message?: { content?: string } }
    // Llama Guard's chat template replies "safe" or "unsafe\n<category>".
    const verdict = (data.message?.content ?? '').trim().toLowerCase()
    return { injection: verdict.startsWith('unsafe') }
  }
}
