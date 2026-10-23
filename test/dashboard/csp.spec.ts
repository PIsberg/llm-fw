import { test, expect } from '@playwright/test'

// The dashboard page is served with a Content-Security-Policy (pinned header by
// header in dashboard.integration.test.ts). A policy is only as good as the
// page it allows: a directive the page needs but the header lacks shows up as
// a silently dead button, a blank chart or a missing favicon, which no unit
// test sees. This drives the real page through the things the policy governs
// (inline on* handlers, inline styles, the data: favicon and SVG backgrounds,
// same-origin fetch, the /events stream, canvas) and fails on the first
// violation the browser reports.
test.describe('Content-Security-Policy', () => {
  test('the page loads and runs under its policy without a violation', async ({ page }) => {
    const violations: string[] = []
    page.on('console', (m) => {
      if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text())
    })
    await page.addInitScript(() => {
      ;(window as unknown as { __csp: string[] }).__csp = []
      document.addEventListener('securitypolicyviolation', (e) => {
        ;(window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective}: ${e.blockedURI}`)
      })
    })

    const response = await page.goto('/')
    expect(response?.headers()['content-security-policy']).toContain("default-src 'none'")

    // Inline onclick handlers and the inline theme script.
    await page.click('#theme-toggle')
    await expect(page.locator('html')).toHaveAttribute('data-theme', /dark|light/)

    // showTab() from an inline handler, then a same-origin fetch to /api/test.
    await page.click('button:has-text("Prompt Testing")')
    await page.fill('#prompt-input', 'hello from the csp spec')
    await page.click('#pg-analyze-btn')
    await expect(page.locator('#pg-result .pg-badge').first()).toBeVisible({ timeout: 30_000 })

    // Canvas chart and the live connection table.
    await page.click('button:has-text("Live Traffic")')
    await expect(page.locator('#traffic-canvas').first()).toBeVisible()

    // The /events EventSource is allowed by connect-src 'self'.
    await page.click('button:has-text("Events")')
    await expect(page.locator('.live-pill')).toBeVisible()

    const reported = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
    expect(reported).toEqual([])
    expect(violations).toEqual([])
  })
})
