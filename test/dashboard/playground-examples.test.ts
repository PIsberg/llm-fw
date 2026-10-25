/**
 * Every Prompt Testing playground example, through /api/test, against the real
 * default pipeline.
 *
 * The playground lists its examples under "Examples llm-fw catches", and until
 * this test nothing checked that claim: the list lived in the page's inline
 * script. It now lives in src/dashboard/playgroundExamples.ts, the page embeds
 * it, and this sends each one the way the page's fillExample() and
 * analyzePrompt() build the request, so a detector change that stops catching
 * an example fails here.
 *
 * Expectations follow the example's labels: a danger example is caught and a
 * `safe` one passes. The "Roleplay (needs judge)" example was labelled that way
 * while the default config blocked it (harmful-request, score 100); this test
 * is what found it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type http from 'node:http'
import type { AddressInfo } from 'node:net'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { PLAYGROUND_EXAMPLES, type PlaygroundExample } from '../../src/dashboard/playgroundExamples.js'
import type { Config } from '../../src/types.js'

// The page's toTagChars(): printable ASCII to invisible Unicode Tag characters.
const toTagChars = (s: string): string =>
  [...s].map(c => {
    const cp = c.codePointAt(0) ?? 0
    return cp >= 0x20 && cp <= 0x7e ? String.fromCodePoint(0xe0000 + cp) : c
  }).join('')
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

/** The /api/test body the page sends for this example (fillExample + analyzePrompt). */
function requestFor(category: string, e: PlaygroundExample): Record<string, unknown> {
  switch (category) {
    case 'url': return { category, url: e.value }
    case 'mcp': return { category, text: e.value }
    case 'guardrails': return { category, text: e.value, tool: e.tool, toggles: { a: true, b: true, c: true, d: true } }
    case 'ascii': return { category, text: (e.visible ?? '') + (e.hidden ? toTagChars(e.hidden) : '') }
    case 'image':
      if (e.png) return { category, dataUrl: `data:image/png;base64,${PNG_1x1}` }
      if (e.pdf) return { category, dataUrl: `data:application/pdf;base64,${Buffer.from(`%PDF-1.4\nstream\nendstream\n%%EOF\n${e.pdf}`, 'latin1').toString('base64')}` }
      return { category, text: e.value }
    default: return { category, text: e.value }
  }
}

/** Whether the response says the example was caught, per category. */
function caught(category: string, d: Record<string, unknown>): boolean {
  if (category === 'dlp') return Number(d.count) > 0
  // An opaque image cannot be inspected; the playground reports it as a warn
  // (audit) or a block (block mode), and either is the example working.
  if (category === 'image' && d.action === 'warn') return true
  return d.action === 'block'
}

const cases = Object.entries(PLAYGROUND_EXAMPLES).flatMap(([category, list]) =>
  list.map(e => ({ category, e, name: `${category}: ${e.label}` })))

describe('playground examples', () => {
  let server: http.Server
  let pipeline: Pipeline
  let base = ''

  beforeAll(async () => {
    const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as Config
    pipeline = new Pipeline(config)
    await pipeline.init()
    server = createDashboardServer(config, new EventBus(config.dashboard), pipeline)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }, 180_000)

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await pipeline.close()
  })

  it('has an example in every category the page offers one for', () => {
    for (const category of ['injection', 'ascii', 'image', 'rag', 'dlp', 'mcp', 'guardrails', 'url']) {
      expect(PLAYGROUND_EXAMPLES[category]?.length, category).toBeGreaterThan(0)
    }
  })

  it.each(cases)('$name', async ({ category, e }) => {
    const res = await fetch(`${base}/api/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestFor(category, e)),
    })
    expect(res.status).toBe(200)
    const d = await res.json() as Record<string, unknown>
    expect(caught(category, d), JSON.stringify(d).slice(0, 300)).toBe(!e.safe)
  }, 60_000)
})
