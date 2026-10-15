import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer, DASHBOARD_HTML } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { writeRuntimeState } from '../../src/cli/runtimeState.js'
import type { Config } from '../../src/types.js'

/**
 * #338: when the sinkhole is active every Node.js and native client on the
 * machine is redirected through llm-fw, and the dashboard gave no sign of it.
 * The running process records what it started (#320); the dashboard reads
 * that record for its own pid and shows it in the header.
 */
describe('GET /api/status', () => {
  let tempDir: string
  let server: http.Server
  let port = 0

  const get = (path: string): Promise<{ status: number; json: any }> => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, res => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(data) }))
    }).on('error', reject)
  })

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-status-api-'))
    process.env.LLM_FW_DIR = tempDir
    const config = structuredClone(DEFAULT_CONFIG) as Config
    config.enforcement = 'observe'
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('reports no sinkhole, and the live enforcement, when this process recorded nothing', async () => {
    const res = await get('/api/status')
    expect(res.status).toBe(200)
    expect(res.json).toMatchObject({ enforcement: 'observe', sinkhole: false, gatewayUrl: null })
  })

  it('reports the sinkhole and gateway this process recorded', async () => {
    writeRuntimeState(tempDir, {
      pid: process.pid, startedAt: '2026-10-15T20:00:00.000Z', enforcement: 'observe',
      proxyUrl: 'http://127.0.0.1:8080', dashboardUrl: 'http://127.0.0.1:7731',
      gatewayUrl: 'http://127.0.0.1:8081', sinkhole: true,
    })
    const res = await get('/api/status')
    expect(res.json).toMatchObject({ sinkhole: true, gatewayUrl: 'http://127.0.0.1:8081', startedAt: '2026-10-15T20:00:00.000Z' })
  })

  it('ignores a record left by another process', async () => {
    writeRuntimeState(tempDir, {
      pid: process.pid + 1, startedAt: 'x', enforcement: 'enforce',
      proxyUrl: '', dashboardUrl: '', gatewayUrl: null, sinkhole: true,
    })
    expect((await get('/api/status')).json.sinkhole).toBe(false)
  })

  it('the header has the mode chips and loads them from /api/status', () => {
    expect(DASHBOARD_HTML).toContain('id="mode-chips"')
    expect(DASHBOARD_HTML).toContain("fetch('/api/status')")
    expect(DASHBOARD_HTML).toContain('Sinkhole active')
  })
})
