import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Pipeline } from '../../src/detection/pipeline.js'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { GatewayServer } from '../../src/gateway/gateway.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// #863: `llm-fw start` built three detection pipelines, one for the
// dashboard, one in the proxy and one in the gateway, and initialised each:
// three sets of anchor embeddings at startup, three item caches, and with
// detection.workerInference off three model loads. The proxy and the gateway
// now take the one start.ts owns, and neither initialises nor closes it.
describe('a pipeline shared by the proxy and the gateway (#863)', () => {
  const init = vi.spyOn(Pipeline.prototype, 'init').mockResolvedValue(undefined)
  const close = vi.spyOn(Pipeline.prototype, 'close').mockResolvedValue(undefined)
  beforeEach(() => { init.mockClear(); close.mockClear() })

  it('is the only one initialised and closed, by its owner', async () => {
    process.env.LLM_FW_DIR = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shared-pipeline-'))
    try {
      const config = structuredClone(DEFAULT_CONFIG)
      config.detection.workerInference = false
      const bus = new EventBus(config.dashboard)
      const shared = new Pipeline(config, e => bus.emit(e))
      await shared.init()
      const proxy = new ProxyServer(config, bus, undefined, undefined, undefined, shared)
      const gateway = new GatewayServer(config, bus, undefined, undefined, undefined, shared)
      await proxy.init()
      await gateway.init()
      expect(init).toHaveBeenCalledOnce()
      expect(init.mock.contexts[0]).toBe(shared)
      await proxy.stop()
      await gateway.stop()
      expect(close).not.toHaveBeenCalled()
      bus.destroy()
    } finally {
      fs.rmSync(process.env.LLM_FW_DIR!, { recursive: true, force: true })
      delete process.env.LLM_FW_DIR
    }
  })

  it('a proxy or gateway built without one still owns its own', async () => {
    process.env.LLM_FW_DIR = fs.mkdtempSync(join(tmpdir(), 'llm-fw-shared-pipeline-'))
    try {
      const config = structuredClone(DEFAULT_CONFIG)
      config.detection.workerInference = false
      const bus = new EventBus(config.dashboard)
      const proxy = new ProxyServer(config, bus)
      await proxy.init()
      await proxy.stop()
      expect(init).toHaveBeenCalledOnce()
      expect(close).toHaveBeenCalledOnce()
      bus.destroy()
    } finally {
      fs.rmSync(process.env.LLM_FW_DIR!, { recursive: true, force: true })
      delete process.env.LLM_FW_DIR
    }
  })
})
