import { test, expect } from '@playwright/test'

// The dashboard follows the OS colour scheme until the header toggle picks one,
// and the pick survives a reload. Pinned here because the choice is stored in
// localStorage and applied by a head script before first paint: a regression in
// either (a renamed key, a dropped attribute) would only show as a flash or a
// theme that forgets itself, which no unit test sees.
test.describe('Colour theme', () => {
  test('follows the OS scheme until the toggle picks one, then remembers the pick', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    const root = page.locator('html')
    await expect(root).not.toHaveAttribute('data-theme', /.+/)
    const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)

    await page.click('#theme-toggle')
    await expect(root).toHaveAttribute('data-theme', 'dark')
    const darkBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(darkBg).not.toBe(lightBg)

    await page.reload()
    await expect(root).toHaveAttribute('data-theme', 'dark')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(darkBg)

    await page.click('#theme-toggle')
    await expect(root).toHaveAttribute('data-theme', 'light')
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(lightBg)
  })

  test('a dark OS scheme renders dark without a stored pick', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.goto('/')
    await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    await page.emulateMedia({ colorScheme: 'light' })
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(bg)
  })
})
