import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defineConfig } from '@playwright/test'

// The working tree, on ports and a data directory of its own (#704). On 7731
// with reuseExistingServer the suite drove whatever answered there, which on
// a developer machine is the installed llm-fw: it passed or failed on code
// nobody had changed. A port already in use now fails the run instead of
// being reused. Proxy mode, so this instance never touches the machine's
// sinkhole (#617).
const DASHBOARD_PORT = '27731'
// Playwright evaluates this file again in every worker, which inherits the
// runner's environment: only the first evaluation empties the directory, so
// a worker never wipes the running server's state and a run leaves one
// directory behind, not one per worker.
const DIR_ENV = 'LLM_FW_PLAYWRIGHT_DIR'
const dataDir = process.env[DIR_ENV] ?? path.join(os.tmpdir(), 'llm-fw-playwright')
if (!process.env[DIR_ENV]) {
  fs.rmSync(dataDir, { recursive: true, force: true })
  fs.mkdirSync(dataDir, { recursive: true })
  process.env[DIR_ENV] = dataDir
}

export default defineConfig({
  testDir: 'test/dashboard',
  testMatch: '**/*.spec.ts',
  use: {
    baseURL: `http://127.0.0.1:${DASHBOARD_PORT}`,
    headless: true,
  },
  webServer: {
    command: 'npx tsx src/cli/index.ts start',
    url: `http://127.0.0.1:${DASHBOARD_PORT}`,
    reuseExistingServer: false,
    env: {
      LLM_FW_DIR: dataDir,
      LLM_FW_DASHBOARD_PORT: DASHBOARD_PORT,
      LLM_FW_PROXY_PORT: '28080',
      LLM_FW_HTTPS_PORT: '28443',
      LLM_FW_GATEWAY_PORT: '28081',
      LLM_FW_PROXY_MODE: 'proxy',
      // The model cache a normal run uses, or CI's, not the fresh directory:
      // a cold cache downloads the embedding model on every run.
      LLM_FW_MODEL_DIR: process.env.LLM_FW_MODEL_DIR || path.join(os.homedir(), '.llm-fw', 'models'),
    },
    timeout: 120_000,
    stdout: 'ignore',
    stderr: 'pipe',
  },
  timeout: 15_000,
})
