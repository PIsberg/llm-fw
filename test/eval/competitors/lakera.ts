import type { CompetitorAdapter } from './adapter.js'

/**
 * Lakera Guard hosted API. Opt-in via LAKERA_API_KEY — there is no default/
 * trial key baked in, so this adapter is inert (available() → false) unless
 * an operator explicitly sets the credential.
 */
export class LakeraGuardAdapter implements CompetitorAdapter {
  name = 'lakera-guard (hosted API)'
  private reason: string | undefined

  async available(): Promise<boolean> {
    if (!process.env.LAKERA_API_KEY) {
      this.reason = 'not run: LAKERA_API_KEY not set'
      return false
    }
    return true
  }

  skipReason(): string | undefined {
    return this.reason
  }

  async classify(text: string): Promise<{ injection: boolean; score?: number }> {
    const key = process.env.LAKERA_API_KEY
    if (!key) throw new Error('lakera: LAKERA_API_KEY not set — call available() first')
    const res = await fetch('https://api.lakera.ai/v2/guard', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
    })
    if (!res.ok) throw new Error(`lakera: HTTP ${res.status}`)
    const data = await res.json() as { flagged?: boolean }
    return { injection: !!data.flagged }
  }
}
