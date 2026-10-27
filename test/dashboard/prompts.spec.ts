import { test, expect, Page, Route } from '@playwright/test'

// The Prompts tab: search, filters, the opt-in switch and Clear. The module and
// its query semantics are pinned by test/modules/promptMonitor.test.ts and the
// route by test/dashboard/prompts-api.test.ts; these drive the page against a
// fake /api/prompts that records the query string it was asked.

interface Row { id: string; timestamp: string; target: string; path: string; model: string; session: string; text: string; chars: number; truncated: boolean }

const row = (n: number, over: Partial<Row> = {}): Row => ({
  id: 'p' + n, timestamp: '2026-10-27T08:0' + n + ':00.000Z', target: 'api.anthropic.com', path: '/v1/messages',
  model: 'claude-opus-5-5', session: '127.0.0.1', text: 'prompt number ' + n, chars: 15, truncated: false, ...over,
})

async function fakeServer(page: Page, rows: Row[], enabled = true) {
  const state = { enabled, rows, queries: [] as URLSearchParams[], switched: [] as boolean[], cleared: 0 }
  await page.route('**/api/prompts?**', async (route: Route) => {
    const q = new URL(route.request().url()).searchParams
    state.queries.push(q)
    const words = (q.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const hit = state.enabled ? state.rows.filter(r => words.every(w => r.text.toLowerCase().includes(w)) && (!q.get('target') || r.target === q.get('target'))) : []
    await route.fulfill({
      json: {
        enabled: state.enabled, entries: hit, total: hit.length,
        facets: { targets: [...new Set(state.rows.map(r => r.target))], models: [...new Set(state.rows.map(r => r.model))], sessions: [...new Set(state.rows.map(r => r.session))] },
      },
    })
  })
  await page.route('**/api/prompts/clear', async route => { state.cleared++; state.rows = []; await route.fulfill({ json: { ok: true } }) })
  await page.route('**/api/modules', async route => {
    if (route.request().method() === 'POST') {
      const body = JSON.parse(route.request().postData() ?? '{}') as { enabled: boolean }
      state.switched.push(body.enabled)
      state.enabled = body.enabled
      if (!body.enabled) state.rows = []
    }
    await route.fulfill({ json: { totalTokensOriginal: 0, totalTokensPruned: 0, totalTokensSaved: 0, overallPercentSaved: 0, tokenEconomy: { enabled: true }, modules: [], summary: {} } })
  })
  return state
}

const open = async (page: Page) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Prompts' }).click()
}

test.describe('Prompts tab', () => {
  test('lists prompts, searches and filters them', async ({ page }) => {
    const s = await fakeServer(page, [row(3), row(2, { target: 'api.openai.com', text: 'write a haiku' }), row(1)])
    await open(page)
    await expect(page.locator('#prompts-body tr')).toHaveCount(3)

    await page.fill('#prompts-search', 'haiku')
    await expect(page.locator('#prompts-body tr')).toHaveCount(1)
    expect(s.queries.at(-1)!.get('q')).toBe('haiku')

    await page.fill('#prompts-search', '')
    await page.selectOption('#prompts-target', 'api.anthropic.com')
    await expect(page.locator('#prompts-body tr')).toHaveCount(2)
    expect(s.queries.at(-1)!.get('target')).toBe('api.anthropic.com')
  })

  test('shows a prompt as text, never as markup', async ({ page }) => {
    await fakeServer(page, [row(1, { text: '<img src=x onerror="window.__pwned=1"> <b>bold</b>' })])
    await open(page)
    await expect(page.locator('#prompts-body td.prompt-text')).toContainText('<img src=x')
    expect(await page.locator('#prompts-body img, #prompts-body b').count()).toBe(0)
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined()
  })

  test('opting out sends the switch and empties the list; opting in sends it back', async ({ page }) => {
    const s = await fakeServer(page, [row(1)])
    await open(page)
    await expect(page.locator('#prompts-toggle')).toBeChecked()
    await page.uncheck('#prompts-toggle')
    await expect(page.locator('#prompts-off')).toBeVisible()
    await expect(page.locator('#prompts-body tr')).toHaveCount(0)
    expect(s.switched).toEqual([false])

    await page.check('#prompts-toggle')
    await expect(page.locator('#prompts-off')).toBeHidden()
    expect(s.switched).toEqual([false, true])
  })

  test('Clear forgets what is held and leaves the monitor on', async ({ page }) => {
    const s = await fakeServer(page, [row(1), row(2)])
    await open(page)
    await expect(page.locator('#prompts-body tr')).toHaveCount(2)
    await page.click('#prompts-clear')
    await expect(page.locator('#prompts-body tr')).toHaveCount(0)
    expect(s.cleared).toBe(1)
    await expect(page.locator('#prompts-toggle')).toBeChecked()
  })

  test('says so when the monitor is off', async ({ page }) => {
    await fakeServer(page, [], false)
    await open(page)
    await expect(page.locator('#prompts-off')).toBeVisible()
    await expect(page.locator('#prompts-toggle')).not.toBeChecked()
  })
})
