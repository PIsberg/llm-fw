import { test, expect, Page, Route } from '@playwright/test'

// Gateway modules on the dashboard: the Tokens Saved tile (#340, #342) and the
// Modules tab (#341). The server side (module SSE events emitted and replayed)
// is pinned by test/gateway/gateway-modules.e2e.test.ts; these drive a browser
// and watch the page change while it stays loaded.

interface Totals { saved: number; original: number; pct: number; applied?: boolean }

function moduleEvent(id: string, t: Totals, extra: Record<string, unknown> = {}) {
  return {
    id, timestamp: '2026-10-16T08:00:00.000Z', moduleId: 'token-pruner',
    moduleName: 'Token Pruner / Cost Optimizer', target: 'api.openai.com',
    path: '/v1/chat/completions', tokensOriginal: 200, tokensPruned: 150,
    tokensSaved: 50, percentSaved: 25, totalTokensSaved: t.saved,
    overallPercentSaved: t.pct, ...(t.applied === undefined ? {} : { applied: t.applied }), ...extra,
  }
}

function modulesBody(t: Totals, enabled = true) {
  const summary = {
    totalTokensOriginal: t.original, totalTokensPruned: t.original - t.saved,
    totalTokensSaved: t.saved, overallPercentSaved: t.pct,
    ...(t.applied === undefined ? {} : { applied: t.applied }),
  }
  return JSON.stringify({
    ...summary,
    summary,
    modules: [{
      id: 'token-pruner', name: 'Token Pruner / Cost Optimizer', enabled,
      description: 'Collapses repeated spaces', totalInvocations: 3,
      tokensOriginal: t.original, tokensPruned: t.original - t.saved,
      tokensSaved: t.saved, percentSaved: t.pct, recentEvents: [],
    }],
  })
}

function sse(events: object[]): string {
  return 'retry: 60000\n' + events.map(e => 'event: module\ndata: ' + JSON.stringify(e) + '\n\n').join('')
}

// /api/modules answers with whatever the "server" holds now; /events is held
// open until push() is called, then delivers the given module events. The
// page is fully loaded, and showing the empty state, before anything arrives.
//
// After a push, `summary` decides what /api/modules does:
// - 'never': it never answers, so only the event stream can change the page.
// - 'last': it answers after the stream's events, so the page's final state is
//   the summary's, the order that exposes a summary disagreeing with the
//   event it summarises. push() then resolves once that answer has landed.
type SummaryOrder = 'never' | 'last'

async function gatedServer(page: Page, initial: Totals) {
  let current = initial
  let order: SummaryOrder | null = null
  let release!: (events: object[]) => void
  const delivered = new Promise<object[]>(r => { release = r })
  let summaryServed!: () => void
  const served = new Promise<void>(r => { summaryServed = r })
  await page.route('**/api/modules', async (route: Route) => {
    if (order === 'never') return
    const late = order === 'last'
    if (late) await new Promise(r => setTimeout(r, 300))
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: modulesBody(current) })
    if (late) summaryServed()
  })
  await page.route('**/events', async (route: Route) => {
    const events = await delivered
    await route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream' }, body: sse(events) })
  })
  return {
    async push(totals: Totals, events: object[], summary: SummaryOrder) {
      current = totals
      order = summary
      release(events)
      if (summary === 'last') {
        await served
        // let the page's fetch().then() render the answer
        await page.waitForTimeout(100)
      }
    },
  }
}

test.describe('Tokens Saved tile (#342)', () => {
  test('updates from a module event without a page refresh', async ({ page }) => {
    const server = await gatedServer(page, { saved: 0, original: 0, pct: 0 })
    let navigations = 0
    page.on('framenavigated', f => { if (f === page.mainFrame()) navigations++ })

    await page.goto('/')
    await expect(page.locator('#stat-tokens-saved')).toHaveText('0')
    const before = navigations

    // The summary never answers, so the change can only come from the stream.
    const t = { saved: 1234, original: 9872, pct: 12.5, applied: true }
    await server.push(t, [moduleEvent('m1', t)], 'never')

    await expect(page.locator('#stat-tokens-saved')).toHaveText('1,234', { timeout: 10_000 })
    await expect(page.locator('#stat-tokens-pct')).toHaveText('12.5% saved')
    expect(navigations).toBe(before)
  })

  test('says "would be saved (observe)" when the module ran as a dry run', async ({ page }) => {
    const server = await gatedServer(page, { saved: 0, original: 0, pct: 0 })
    await page.goto('/')
    await expect(page.locator('#stat-tokens-saved')).toHaveText('0')

    // The /api/modules summary the page fetches when the stream opens must
    // agree with the event. It carried no applied flag, so when it landed
    // last, observe mode claimed savings it never made.
    const t = { saved: 40, original: 400, pct: 10, applied: false }
    await server.push(t, [moduleEvent('m1', t)], 'last')

    await expect(page.locator('#stat-tokens-saved')).toHaveText('40')
    await expect(page.locator('#stat-tokens-pct')).toHaveText('10% would be saved (observe)')
  })
})

test.describe('Modules tab (#341)', () => {
  test('lists each module with its KPIs and adds activity rows as they arrive', async ({ page }) => {
    const server = await gatedServer(page, { saved: 0, original: 0, pct: 0 })
    await page.goto('/')
    await page.click('button:has-text("Modules")')

    const card = page.locator('.module-card[data-module="token-pruner"]')
    await expect(card).toContainText('Token Pruner / Cost Optimizer')
    await expect(page.locator('#modules-body tr.module-row')).toHaveCount(0)

    const t = { saved: 90, original: 600, pct: 15, applied: true }
    await server.push(t, [
      moduleEvent('m1', { ...t, saved: 50 }, { target: 'api.openai.com', timestamp: '2026-10-16T08:00:00.000Z' }),
      moduleEvent('m2', t, { target: 'api.anthropic.com', path: '/v1/messages', tokensOriginal: 400, tokensPruned: 360, tokensSaved: 40, percentSaved: 10, timestamp: '2026-10-16T08:00:05.000Z' }),
    ], 'last')

    const rows = page.locator('#modules-body tr.module-row')
    await expect(rows).toHaveCount(2)
    // Newest first, like the Events table.
    await expect(rows.first()).toContainText('api.anthropic.com')
    await expect(rows.first()).toContainText('/v1/messages')
    await expect(rows.first().locator('.module-saved')).toHaveText('-10%')
    await expect(rows.nth(1)).toContainText('api.openai.com')

    await expect(card.locator('[data-kpi="saved"]')).toHaveText('90')
    await expect(card.locator('[data-kpi="original"]')).toHaveText('600')
    await expect(card.locator('[data-kpi="ratio"]')).toHaveText('15%')
    await expect(card.locator('[data-kpi="requests"]')).toHaveText('3')
  })

  // Token Economy is the parent switch (modules.enabled): off, the sub-module
  // cards dim but keep their own switches.
  test('switches Token Economy off and dims the sub-modules', async ({ page }) => {
    let economy = true
    const posts: unknown[] = []
    await page.route('**/api/modules', async (route: Route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { id: string; enabled: boolean }
        posts.push(body)
        if (body.id === 'token-economy') economy = body.enabled
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true, tokenEconomy: { id: 'token-economy', name: 'Token Economy', enabled: economy } }) })
        return
      }
      const base = JSON.parse(modulesBody({ saved: 0, original: 0, pct: 0 }))
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, tokenEconomy: { id: 'token-economy', name: 'Token Economy', enabled: economy } }) })
    })
    await page.goto('/')
    await page.click('button:has-text("Modules")')

    const toggle = page.locator('#token-economy-toggle')
    await expect(toggle).toBeChecked()
    await expect(page.locator('#module-cards')).not.toHaveClass(/economy-off/)
    await expect(page.locator('.module-card[data-module="token-pruner"] input')).toBeChecked()

    await toggle.uncheck()
    await expect(page.locator('#module-cards')).toHaveClass(/economy-off/)
    await expect(toggle).not.toBeChecked()
    expect(posts).toEqual([{ id: 'token-economy', enabled: false }])
    // The sub-module's own switch is untouched.
    await expect(page.locator('.module-card[data-module="token-pruner"] input')).toBeChecked()
  })

  // Tool Usage carries its finding as one line of text, the tools to name
  // in the Tool Filter.
  test('shows a module\'s detail line, escaped', async ({ page }) => {
    await page.route('**/api/modules', async (route: Route) => {
      const base = JSON.parse(modulesBody({ saved: 0, original: 0, pct: 0 }))
      base.modules.push({
        id: 'tool-usage', name: 'Tool Usage', enabled: true, description: 'Records which offered tools get called',
        totalInvocations: 2, tokensOriginal: 0, tokensPruned: 0, tokensSaved: 0, percentSaved: 0, recentEvents: [],
        kpis: [{ key: 'never', label: 'Never called', value: 2 }],
        detail: 'Never called, largest first (tokens per request): NotebookEdit (1,204), <b>CronCreate</b> (310)',
      })
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) })
    })
    await page.goto('/')
    await page.click('button:has-text("Modules")')
    const detail = page.locator('.module-card[data-module="tool-usage"] .module-card-detail')
    await expect(detail).toHaveText('Never called, largest first (tokens per request): NotebookEdit (1,204), <b>CronCreate</b> (310)')
    await expect(page.locator('.module-card[data-module="token-pruner"] .module-card-detail')).toHaveCount(0)
  })

  // #354: a module's options are edited on its card and saved together; the
  // server's validation error is shown next to the Save button.
  test('edits a module\'s options on its card and shows the server\'s answer', async ({ page }) => {
    const posts: unknown[] = []
    let maxMessages = 100
    await page.route('**/api/modules', async (route: Route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { id: string; options: { maxMessages: number } }
        posts.push(body)
        if (body.options.maxMessages < 2) {
          await route.fulfill({ status: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'maxMessages must be between 2 and 100000' }) })
          return
        }
        maxMessages = body.options.maxMessages
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) })
        return
      }
      const base = JSON.parse(modulesBody({ saved: 0, original: 0, pct: 0 }))
      base.modules.push({
        id: 'history-window', name: 'History Window', enabled: false, description: 'Keeps the last turns',
        totalInvocations: 0, tokensOriginal: 0, tokensPruned: 0, tokensSaved: 0, percentSaved: 0, recentEvents: [],
        options: [
          { key: 'maxMessages', type: 'number', value: maxMessages, min: 2, max: 100000 },
          { key: 'step', type: 'number', value: 25, min: 1, max: 100000 },
        ],
      })
      base.modules.push({
        id: 'cache-control', name: 'Prompt Cache Marker', enabled: false, description: 'Caches',
        totalInvocations: 0, tokensOriginal: 0, tokensPruned: 0, tokensSaved: 0, percentSaved: 0, recentEvents: [],
        options: [{ key: 'ttl', type: 'enum', value: '5m', values: ['5m', '1h'] }, { key: 'cacheSystem', type: 'boolean', value: true }],
      })
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) })
    })
    await page.goto('/')
    await page.click('button:has-text("Modules")')

    const card = page.locator('.module-card[data-module="history-window"]')
    await card.locator('.module-options summary').click()
    const field = card.locator('[data-option="maxMessages"]')
    await expect(field).toHaveValue('100')
    await field.fill('1')
    await card.locator('.module-options-form button[type="submit"]').click()
    await expect(card.locator('.module-options-status')).toHaveText('maxMessages must be between 2 and 100000')
    await expect(card.locator('.module-options-status')).toHaveClass(/is-error/)

    await field.fill('50')
    await card.locator('.module-options-form button[type="submit"]').click()
    await expect(card.locator('.module-options-status')).toHaveText('Saved')
    expect(posts).toEqual([
      { id: 'history-window', options: { maxMessages: 1, step: 25 } },
      { id: 'history-window', options: { maxMessages: 50, step: 25 } },
    ])
    // The re-rendered card shows the live value the server now holds.
    await expect(page.locator('.module-card[data-module="history-window"] [data-option="maxMessages"]')).toHaveValue('50')
    // A module without options has no editor; enums render as a select.
    await expect(page.locator('.module-card[data-module="token-pruner"] .module-options')).toHaveCount(0)
    await expect(page.locator('.module-card[data-module="cache-control"] select[data-option="ttl"]')).toHaveValue('5m')
  })

  // #407: Tool Usage offers its never-called list as one click into the
  // Tool Filter; the click is armed first, since it changes what the agent
  // can call.
  test('applies a module\'s one-click action after a second click', async ({ page }) => {
    const posts: unknown[] = []
    await page.route('**/api/modules', async (route: Route) => {
      if (route.request().method() === 'POST') {
        posts.push(route.request().postDataJSON())
        await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) })
        return
      }
      const base = JSON.parse(modulesBody({ saved: 0, original: 0, pct: 0 }))
      base.modules.push({
        id: 'tool-usage', name: 'Tool Usage', enabled: true, description: 'Records which offered tools get called',
        totalInvocations: 2, tokensOriginal: 0, tokensPruned: 0, tokensSaved: 0, percentSaved: 0, recentEvents: [],
        kpis: [{ key: 'never', label: 'Never called', value: 2 }],
        detail: 'Never called: NotebookEdit (1,204), CronCreate (310)',
        action: posts.length ? undefined : { label: 'Drop these 2 tools in the Tool Filter', module: 'tool-filter', enabled: true, options: { dropTools: ['NotebookEdit', 'CronCreate'] } },
      })
      await route.fulfill({ status: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(base) })
    })
    await page.goto('/')
    await page.click('button:has-text("Modules")')
    const button = page.locator('.module-card[data-module="tool-usage"] button.module-action')
    await expect(button).toHaveText('Drop these 2 tools in the Tool Filter')
    await button.click()
    await expect(button).toHaveText('Click again to confirm')
    expect(posts).toEqual([])
    await button.click()
    await expect.poll(() => posts.length).toBe(1)
    expect(posts).toEqual([{ id: 'tool-filter', enabled: true, options: { dropTools: ['NotebookEdit', 'CronCreate'] } }])
    // The refreshed card no longer offers it.
    await expect(page.locator('.module-card[data-module="tool-usage"] button.module-action')).toHaveCount(0)
  })

  test('marks a dry-run row as observed, not saved', async ({ page }) => {
    const server = await gatedServer(page, { saved: 0, original: 0, pct: 0 })
    await page.goto('/')
    await page.click('button:has-text("Modules")')
    const t = { saved: 50, original: 200, pct: 25, applied: false }
    await server.push(t, [moduleEvent('m1', t)], 'last')
    const row = page.locator('#modules-body tr.module-row').first()
    await expect(row).toBeVisible()
    await expect(row).toContainText('would save')
  })
})
