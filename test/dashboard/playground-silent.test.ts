import { describe, it, expect, vi } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// #918: the playground's scans went into the live event feed, Prometheus and
// the audit trail. It asks the pipeline for a silent run.
describe('the playground scans silently (#918)', () => {
  it.each([
    [{ prompt: 'hello there' }, true],
    [{ prompt: 'hello there', record: true }, false],
  ])('runs %j with silent: %s', async (payload, silent) => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-918-'))
    process.env.LLM_FW_DIR = dir
    const run = vi.fn().mockResolvedValue({ action: 'pass', stage: 'none', score: 0, similarity: 0 })
    const config = structuredClone(DEFAULT_CONFIG) as Config
    const server = createDashboardServer(config, new EventBus(config.dashboard), { run } as never)
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as { port: number }).port
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/api/test', method: 'POST', headers: { 'Content-Type': 'application/json', Host: `127.0.0.1:${port}`, Origin: `http://127.0.0.1:${port}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
        req.on('error', reject)
        req.end(JSON.stringify(payload))
      })
      expect(status).toBe(200)
      expect(run).toHaveBeenCalled()
      for (const call of run.mock.calls) expect(call[2]).toMatchObject({ silent })
    } finally {
      server.closeAllConnections()
      await new Promise<void>(r => server.close(() => r()))
      delete process.env.LLM_FW_DIR
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})
