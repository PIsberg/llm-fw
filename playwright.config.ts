import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'test/dashboard',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:7731',
    headless: true,
  },
  webServer: {
    command: 'npx tsx src/cli/index.ts start',
    url: 'http://127.0.0.1:7731',
    reuseExistingServer: true,
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  timeout: 15_000,
})
