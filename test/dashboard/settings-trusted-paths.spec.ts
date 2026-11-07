import { test, expect } from '@playwright/test'

// The trusted project roots in Settings (#703): shown, added, refused when
// the matcher could never use them, and removed, each saved as a whole list.
test.describe('Settings: trusted project roots (#703)', () => {
  test('adds a root, refuses a relative one, and removes it again', async ({ page, request }) => {
    const before = (await (await request.get('/api/settings')).json()).trustedPaths as string[]
    const root = process.platform === 'win32' ? 'C:\\pw\\trusted-project' : '/pw/trusted-project'
    try {
      await page.goto('/')
      await page.click('button:has-text("Settings")')
      const control = page.locator('#set-trustedPaths')
      await expect(control).toBeVisible()

      await control.locator('[data-path-new]').fill(`  ${root}  `)
      await control.locator('[data-path-add]').click()
      await expect(control.locator('.settings-path', { hasText: root })).toHaveCount(1)
      expect((await (await request.get('/api/settings')).json()).trustedPaths).toEqual([...before, root])

      await page.locator('#set-trustedPaths [data-path-new]').fill('relative/project')
      await page.locator('#set-trustedPaths [data-path-add]').click()
      await expect(page.locator('#settings-saved')).toContainText('must be an absolute path')
      expect((await (await request.get('/api/settings')).json()).trustedPaths).toEqual([...before, root])

      await page.locator('#set-trustedPaths .settings-path', { hasText: root }).getByRole('button', { name: `Remove ${root}` }).click()
      await expect(page.locator('#set-trustedPaths .settings-path', { hasText: root })).toHaveCount(0)
      expect((await (await request.get('/api/settings')).json()).trustedPaths).toEqual(before)
    } finally {
      await request.post('/api/settings', { data: { trustedPaths: before } })
    }
  })
})
