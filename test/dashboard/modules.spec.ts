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
