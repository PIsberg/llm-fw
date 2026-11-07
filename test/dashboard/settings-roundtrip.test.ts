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
 * Every control the Settings tab renders, driven through the API it calls.
 * Per-setting tests covered 32 of the 46 keys; this walks all of them from
 * the page itself, so a new row that shows but does not apply, or applies but
 * does not survive a restart, fails here without anyone writing a test for it.
 */
describe('dashboard settings: every control round-trips', () => {
  let tempDir: string
  let server: http.Server | undefined
  let port = 0

  function request(method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> {
    const payload = body === undefined ? '' : JSON.stringify(body)
    return new Promise((resolve, reject) => {
      const r = http.request({
        host: '127.0.0.1', port, method, path,
        headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(payload)) },
      }, res => {
        let text = ''
        res.on('data', c => { text += c })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }))
      })
      r.on('error', reject)
      r.end(payload)
    })
  }

  async function serve(config: Config): Promise<void> {
    await stop()
    server = createDashboardServer(config, new EventBus(config.dashboard), undefined as any, undefined, undefined, new ModuleManager(config))
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    port = (server.address() as { port: number }).port
  }

  async function stop(): Promise<void> {
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server!.close(() => resolve()))
    server = undefined
  }

  /** The rows of the page's SETTINGS_SCHEMA, as the browser sees them. */
  async function schemaRows(): Promise<Array<{ key: string; type: string; options?: string[]; min?: number; max?: number; step?: number }>> {
    const html = (await request('GET', '/')).text
    const start = html.indexOf('const SETTINGS_SCHEMA = [')
    expect(start).toBeGreaterThan(-1)
    const block = html.slice(start, html.indexOf('\n];', start))
    const rows = []
    for (const m of block.matchAll(/\{ key: '(\w+)'[^\n]*/g)) {
      const line = m[0]
      const type = /type: '(\w+)'/.exec(line)?.[1] ?? 'toggle'
      const options = /options: \[([^\]]*)\]/.exec(line)?.[1].split(',').map(s => s.trim().replace(/^'|'$/g, ''))
      const num = (name: string): number | undefined => {
        const v = new RegExp(name + ': ([\\d.]+)').exec(line)?.[1]
        return v === undefined ? undefined : Number(v)
      }
      rows.push({ key: m[1], type, options, min: num('min'), max: num('max'), step: num('step') })
    }
    return rows
  }

  function changed(row: Awaited<ReturnType<typeof schemaRows>>[number], current: unknown): unknown {
    switch (row.type) {
      case 'toggle': return !current
      case 'select': return row.options!.find(o => o !== current)
      case 'text': return 'roundtrip-model:1b'
      case 'paths': return [...(current as string[]), process.platform === 'win32' ? 'C:\\roundtrip\\project' : '/roundtrip/project']
      case 'number': {
        const step = row.step ?? 1
        const up = Number(current) + step
        const next = row.max !== undefined && up > row.max ? Number(current) - step : up
        return Math.round(next * 1000) / 1000
      }
      default: throw new Error(`unknown row type ${row.type} for ${row.key}`)
    }
  }

  beforeEach(() => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-settings-roundtrip-'))
    process.env.LLM_FW_DIR = tempDir
  })

  afterEach(async () => {
    await stop()
    delete process.env.LLM_FW_DIR
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('applies every row live, reports it, and keeps it across a restart', async () => {
    await serve(await loadConfig())
    const rows = await schemaRows()
    expect(rows.length).toBeGreaterThanOrEqual(46)
    const initial = JSON.parse((await request('GET', '/api/settings')).text)

    const want: Record<string, unknown> = {}
    for (const row of rows) {
      expect(initial, `GET /api/settings has no "${row.key}", which the page renders`).toHaveProperty(row.key)
      want[row.key] = changed(row, initial[row.key])
      const res = await request('POST', '/api/settings', { [row.key]: want[row.key] })
      const body = JSON.parse(res.text)
      expect(res.status, `${row.key}: ${res.text}`).toBe(200)
      expect(body.applied, row.key).toContain(row.key)
      expect(body.errors, row.key).toEqual([])
      expect(body.settings[row.key], `${row.key} in the POST response`).toEqual(want[row.key])
    }

    const live = JSON.parse((await request('GET', '/api/settings')).text)
    for (const row of rows) expect(live[row.key], `${row.key} after every other row changed`).toEqual(want[row.key])

    await serve(await loadConfig())
    const restarted = JSON.parse((await request('GET', '/api/settings')).text)
    for (const row of rows) expect(restarted[row.key], `${row.key} after a restart`).toEqual(want[row.key])
  })

  it('refuses a select option the page does not offer, and changes nothing', async () => {
    await serve(await loadConfig())
    const before = (await request('GET', '/api/settings')).text
    for (const row of (await schemaRows()).filter(r => r.type === 'select')) {
      const res = await request('POST', '/api/settings', { [row.key]: 'not-an-option' })
      expect(res.status, `${row.key}: ${res.text}`).toBe(400)
    }
    expect((await request('GET', '/api/settings')).text).toBe(before)
  })
})
