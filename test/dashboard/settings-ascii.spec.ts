import { test, expect, Page } from '@playwright/test'

async function openPlayground(page: Page) {
  await page.goto('/')
  await page.click('button:has-text("Prompt Testing")')
}
async function selectCategory(page: Page, label: string) {
  await page.click(`#pg-cats .pg-mode-btn:has-text("${label}")`)
}
async function openSettings(page: Page) {
  await page.goto('/')
  await page.click('button:has-text("Settings")')
  await expect(page.locator('#settings-body')).toBeVisible()
}
// The checkbox is visually hidden behind a styled slider (accessible toggle
// pattern); a real user clicks the slider, which toggles the input via the
// wrapping <label> and fires the change handler.
const slider = (page: Page, key: string) => page.locator(`#set-${key} + .slider`)

test.describe('Prompt Testing — ASCII smuggling', () => {
  test('invisible Unicode-tag payload is blocked with decoded text', async ({ page }) => {
    await openPlayground(page)
    await selectCategory(page, 'ASCII Smuggling')
    await page.click('.pg-ex:has-text("Invisible override")')
    await expect(page.locator('#pg-result')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#pg-result .pg-badge')).toHaveText('BLOCK')
    await expect(page.locator('#pg-result')).toContainText('stage: ascii-smuggling')
    await expect(page.locator('#pg-result')).toContainText('decoded:')
    await expect(page.locator('#pg-result')).toContainText('ignore all previous instructions')
  })

  test('plain visible text passes', async ({ page }) => {
    await openPlayground(page)
    await selectCategory(page, 'ASCII Smuggling')
    await page.click('.pg-ex:has-text("Plain visible text")')
    await expect(page.locator('#pg-result')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#pg-result .pg-badge')).toHaveText('PASS')
  })
})

test.describe('Settings tab', () => {
  test('renders grouped toggles reflecting current config', async ({ page }) => {
    await openSettings(page)
    await expect(page.locator('.settings-group')).toHaveCount(6)
    await expect(page.locator('#set-asciiSmuggling')).toBeChecked()
    await expect(page.locator('#set-dlpMode')).toHaveValue('redact')
    // Non-text Content group — OCR is opt-in (unchecked) by default.
    await expect(page.locator('#set-nonTextOcr')).not.toBeChecked()
  })

  test('toggling a defense shows a saved indicator and takes effect live', async ({ page }) => {
    // Disable ASCII smuggling from the Settings UI by clicking its slider.
    await openSettings(page)
    await expect(page.locator('#set-asciiSmuggling')).toBeChecked()
    await slider(page, 'asciiSmuggling').click()
    await expect(page.locator('#set-asciiSmuggling')).not.toBeChecked()
    await expect(page.locator('#settings-saved')).toContainText('Saved')

    // The same invisible payload now PASSES in the playground (live toggle).
    await openPlayground(page)
    await selectCategory(page, 'ASCII Smuggling')
    await page.click('.pg-ex:has-text("Invisible override")')
    await expect(page.locator('#pg-result')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#pg-result .pg-badge')).toHaveText('PASS')

    // Re-enable and confirm it blocks again — also restores config for other runs.
    await openSettings(page)
    await slider(page, 'asciiSmuggling').click()
    await expect(page.locator('#set-asciiSmuggling')).toBeChecked()
    await expect(page.locator('#settings-saved')).toContainText('Saved')
    await openPlayground(page)
    await selectCategory(page, 'ASCII Smuggling')
    await page.click('.pg-ex:has-text("Invisible override")')
    await expect(page.locator('#pg-result')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('#pg-result .pg-badge')).toHaveText('BLOCK')
  })

  test('settings persist across a page reload', async ({ page }) => {
    await openSettings(page)
    await expect(page.locator('#set-dos')).toBeChecked()
    await slider(page, 'dos').click()
    await expect(page.locator('#set-dos')).not.toBeChecked()
    await expect(page.locator('#settings-saved')).toContainText('Saved')
    await page.reload()
    await page.click('button:has-text("Settings")')
    await expect(page.locator('#set-dos')).not.toBeChecked()
    // restore
    await slider(page, 'dos').click()
    await expect(page.locator('#set-dos')).toBeChecked()
    await expect(page.locator('#settings-saved')).toContainText('Saved')
  })
})
