import { describe, it, expect } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import config from '../../playwright.config.js'

// #704: the dashboard suite drove whatever answered on 7731, which on a
// developer machine is the installed llm-fw, not the working tree.
describe('playwright config', () => {
  const server = Array.isArray(config.webServer) ? config.webServer[0]! : config.webServer!
  const env = server.env ?? {}
  const INSTALLED_PORTS = ['7731', '8080', '8081', '8443']

  it('starts the working tree on ports an installed llm-fw does not use', () => {
    const port = new URL(String(config.use?.baseURL)).port
    expect(INSTALLED_PORTS).not.toContain(port)
    expect(new URL(String(server.url)).port).toBe(port)
    expect(env.LLM_FW_DASHBOARD_PORT).toBe(port)
    for (const key of ['LLM_FW_PROXY_PORT', 'LLM_FW_HTTPS_PORT', 'LLM_FW_GATEWAY_PORT']) {
      expect(env[key], key).toMatch(/^\d+$/)
      expect(INSTALLED_PORTS, key).not.toContain(env[key])
    }
    expect(env.LLM_FW_PROXY_MODE).toBe('proxy')
  })

  it('never reuses a server already on the port', () => {
    expect(server.reuseExistingServer).toBe(false)
  })

  it('gives the server a data directory of its own, not ~/.llm-fw', () => {
    const dir = env.LLM_FW_DIR
    expect(dir).toBeTruthy()
    expect(path.resolve(dir!)).not.toBe(path.resolve(os.homedir(), '.llm-fw'))
    expect(path.resolve(dir!).startsWith(path.resolve(os.tmpdir()))).toBe(true)
  })

  it('keeps the model cache out of that fresh directory, so a run does not download it again', () => {
    expect(env.LLM_FW_MODEL_DIR).toBeTruthy()
    expect(path.resolve(env.LLM_FW_MODEL_DIR!).startsWith(path.resolve(env.LLM_FW_DIR!))).toBe(false)
  })
})
