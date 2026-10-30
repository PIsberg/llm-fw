import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'node:http'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createDashboardServer } from '../../src/dashboard/server.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { ModuleManager } from '../../src/modules/registry.js'
import { loadConfig } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

/**
 * The per-surface detection settings in the dashboard (#543). They existed in
 * config.json (`detection.surfaces.*`, all warm) but the Settings view neither
 * showed nor edited them, so an operator could not see that a tool result is
 * withheld rather than refused, or tune the untrusted surfaces apart from the
 * user's prompt, without reading the source.
 */
describe('dashboard settings: per-surface detection', () => {
  let tempDir: string
  let server: http.Server
  let port = 0

  function request(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    const payload = body === undefined ? '' : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, res => {
        let text = ''
        res.on('data', c => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }))
      })
      r.on('error', reject)
      r.end(payload)
    })
  }

  async function serve(config: Config): Promise<void> {
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any, undefined, undefined, new ModuleManager(config))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }

  const saved = (): any => JSON.parse(fs.readFileSync(join(tempDir, 'config.json'), 'utf8'))

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-settings-surfaces-'))
    process.env.LLM_FW_DIR = tempDir
  })

  afterEach(async () => {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('shows the effective value of every surface setting, falling back to the global one', async () => {
    await serve(await loadConfig())
    const { json } = await request('GET', '/api/settings')
    expect(json).toMatchObject({
      toolResultOnBlock: 'withhold',
      promptOlderTurns: 'withhold',
      promptWordingAction: 'block',
      toolResultHeuristicThreshold: 50,
      documentHeuristicThreshold: 50,
      toolResultClassifierThreshold: 0.9,
      documentClassifierThreshold: 0.9,
    })
  })

  it('applies a surface setting live, leaves the global one alone, and persists only that leaf', async () => {
    fs.writeFileSync(join(tempDir, 'config.json'), JSON.stringify({ detection: { surfaces: { tool_result: { trustedPaths: ['C:/work'] } } } }))
    const config = await loadConfig()
    await serve(config)

    const res = await request('POST', '/api/settings', { toolResultOnBlock: 'refuse', toolResultHeuristicThreshold: 40, documentClassifierThreshold: 0.97 })
    expect(res.status).toBe(200)
    expect(res.json.applied).toEqual(['toolResultOnBlock', 'toolResultHeuristicThreshold', 'documentClassifierThreshold'])

    expect(config.detection.surfaces?.tool_result?.onBlock).toBe('refuse')
    expect(config.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBe(40)
    expect(config.detection.surfaces?.document?.classifierBlockThreshold).toBe(0.97)
    expect(config.detection.heuristicBlockThreshold).toBe(50)
    expect(config.detection.surfaces?.tool_result?.trustedPaths).toEqual(['C:/work'])

    expect(saved().detection.surfaces).toEqual({
      tool_result: { trustedPaths: ['C:/work'], onBlock: 'refuse', heuristicBlockThreshold: 40 },
      document: { classifierBlockThreshold: 0.97 },
    })
    expect(saved().detection.heuristicBlockThreshold).toBeUndefined()

    const { json } = await request('GET', '/api/settings')
    expect(json.toolResultHeuristicThreshold).toBe(40)
    expect(json.documentHeuristicThreshold).toBe(50)
  })

  it('edits the prompt surface: older turns and the wording action', async () => {
    const config = await loadConfig()
    await serve(config)
    expect((await request('POST', '/api/settings', { promptOlderTurns: 'refuse', promptWordingAction: 'warn' })).status).toBe(200)
    expect(config.detection.surfaces?.prompt).toMatchObject({ olderTurns: 'refuse', wordingAction: 'warn' })
    expect(saved().detection.surfaces.prompt).toEqual({ olderTurns: 'refuse', wordingAction: 'warn' })
  })

  it('rejects values outside each setting\'s range', async () => {
    const config = await loadConfig()
    await serve(config)
    const res = await request('POST', '/api/settings', { toolResultOnBlock: 'drop', toolResultHeuristicThreshold: 0, documentClassifierThreshold: 1.5 })
    expect(res.status).toBe(400)
    expect(res.json.errors).toHaveLength(3)
    expect(config.detection.surfaces?.tool_result?.onBlock).toBe('withhold')
    expect(config.detection.surfaces?.tool_result?.heuristicBlockThreshold).toBeUndefined()
  })
})
