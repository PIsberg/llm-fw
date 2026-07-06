import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { InferenceWorkerClient, WorkerUnavailableError, type WorkerFactory } from '../../src/detection/inferenceWorker.js'

// A minimal fake Worker: an EventEmitter with postMessage()/terminate(), so
// tests can drive message/error/exit events without spawning a real thread.
class FakeWorker extends EventEmitter {
  posted: { id: number; kind: string; text?: string; model?: string }[] = []
  terminated = false
  postMessage(msg: { id: number; kind: string; text?: string; model?: string }): void {
    this.posted.push(msg)
  }
  terminate(): Promise<number> {
    this.terminated = true
    this.emit('exit', 0)
    return Promise.resolve(0)
  }
}

function makeClient() {
  const workers: FakeWorker[] = []
  const factory: WorkerFactory = vi.fn((_url: URL, _opts: { execArgv: string[] }) => {
    const w = new FakeWorker()
    workers.push(w)
    return w as unknown as Worker
  })
  const client = new InferenceWorkerClient(factory)
  return { client, factory: factory as unknown as ReturnType<typeof vi.fn>, workers }
}

describe('InferenceWorkerClient (Task C3)', () => {
  // Belt-and-suspenders: a couple of tests below intentionally spy on
  // console.warn without a local mockRestore() (they only assert absence of
  // OTHER calls); reset globally so no spy/call-history ever leaks across
  // tests regardless of ordering.
  afterEach(() => { vi.restoreAllMocks() })

  it('does not spawn a worker until the first request', () => {
    const { factory } = makeClient()
    expect(factory).not.toHaveBeenCalled()
  })

  it('embed() spawns lazily, posts a single-text request, and resolves from the worker response', async () => {
    const { client, factory, workers } = makeClient()
    const promise = client.embed('hello world')
    expect(factory).toHaveBeenCalledTimes(1)

    const worker = workers[0]
    expect(worker.posted).toHaveLength(1)
    expect(worker.posted[0].kind).toBe('embed')
    expect(worker.posted[0].text).toBe('hello world')

    const vector = new Float32Array([0.1, 0.2, 0.3])
    worker.emit('message', { id: worker.posted[0].id, ok: true, kind: 'embed', result: vector })

    await expect(promise).resolves.toEqual(vector)
  })

  it('classify() and ensure() round-trip through the same worker', async () => {
    const { client, workers } = makeClient()
    const classifyPromise = client.classify('some text')
    const worker = workers[0]
    worker.emit('message', { id: worker.posted[0].id, ok: true, kind: 'classify', result: [{ label: 'SAFE', score: 0.9 }] })
    await expect(classifyPromise).resolves.toEqual([{ label: 'SAFE', score: 0.9 }])

    const ensurePromise = client.ensure('embed')
    expect(worker.posted[1].kind).toBe('ensure')
    expect(worker.posted[1].model).toBe('embed')
    worker.emit('message', { id: worker.posted[1].id, ok: true, kind: 'ensure' })
    await expect(ensurePromise).resolves.toBeUndefined()
  })

  it('reuses the same worker across multiple requests (single persistent worker)', async () => {
    const { client, factory, workers } = makeClient()
    const p1 = client.embed('a')
    const p2 = client.embed('b')
    expect(factory).toHaveBeenCalledTimes(1)
    const worker = workers[0]
    worker.emit('message', { id: worker.posted[0].id, ok: true, kind: 'embed', result: new Float32Array([1]) })
    worker.emit('message', { id: worker.posted[1].id, ok: true, kind: 'embed', result: new Float32Array([2]) })
    await expect(p1).resolves.toEqual(new Float32Array([1]))
    await expect(p2).resolves.toEqual(new Float32Array([2]))
  })

  it('rejects with the worker-reported message on an ok:false response', async () => {
    const { client, workers } = makeClient()
    const promise = client.embed('bad')
    const worker = workers[0]
    worker.emit('message', { id: worker.posted[0].id, ok: false, error: 'model exploded' })
    await expect(promise).rejects.toThrow('model exploded')
  })

  it('crash policy: first death rejects in-flight requests and respawns for the NEXT request', async () => {
    const { client, factory, workers } = makeClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const p1 = client.embed('a')
    workers[0].emit('exit', 1) // crash
    await expect(p1).rejects.toThrow(/exited with code 1/)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('respawning'))
    expect(client.isAvailable()).toBe(true) // not permanently disabled yet

    // The NEXT request spawns a fresh worker and succeeds normally.
    const p2 = client.embed('b')
    expect(factory).toHaveBeenCalledTimes(2)
    const worker2 = workers[1]
    worker2.emit('message', { id: worker2.posted[0].id, ok: true, kind: 'embed', result: new Float32Array([9]) })
    await expect(p2).resolves.toEqual(new Float32Array([9]))

    warn.mockRestore()
  })

  it('crash policy: second death permanently falls back to in-process and stops spawning', async () => {
    const { client, factory, workers } = makeClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const p1 = client.embed('a')
    workers[0].emit('exit', 1)
    await expect(p1).rejects.toThrow()

    const p2 = client.embed('b')
    workers[1].emit('exit', 1)
    await expect(p2).rejects.toThrow()

    expect(client.isAvailable()).toBe(false)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back to in-process'))
    expect(factory).toHaveBeenCalledTimes(2)

    // A THIRD call never touches the worker again — it fails fast, synchronously
    // signaling the caller to use its own in-process fallback.
    await expect(client.embed('c')).rejects.toThrow(WorkerUnavailableError)
    expect(factory).toHaveBeenCalledTimes(2)

    warn.mockRestore()
  })

  it('counts an error+exit pair for the same crash only once', async () => {
    const { client, workers } = makeClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const p1 = client.embed('a')
    const worker1 = workers[0]
    worker1.emit('error', new Error('uncaught in worker'))
    worker1.emit('exit', 1)
    await expect(p1).rejects.toThrow()

    // Only ONE crash counted -> respawn, not permanent fallback.
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('respawning'))
    expect(client.isAvailable()).toBe(true)

    warn.mockRestore()
  })

  it('never leaves a request hanging: every pending promise settles on crash', async () => {
    const { client, workers } = makeClient()
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const p1 = client.embed('a')
    const p2 = client.embed('b')
    const p3 = client.classify('c')
    workers[0].emit('exit', 1)

    await expect(p1).rejects.toThrow()
    await expect(p2).rejects.toThrow()
    await expect(p3).rejects.toThrow()
  })

  it('close() terminates the worker and rejects any pending requests', async () => {
    const { client, workers } = makeClient()
    const p1 = client.embed('a')
    const worker = workers[0]
    const terminateSpy = vi.spyOn(worker, 'terminate')

    await client.close()

    await expect(p1).rejects.toThrow(/shutting down/)
    expect(terminateSpy).toHaveBeenCalledTimes(1)
  })

  it('close() is a safe no-op when no worker was ever spawned', async () => {
    const { client, factory } = makeClient()
    await expect(client.close()).resolves.toBeUndefined()
    expect(factory).not.toHaveBeenCalled()
  })

  it('close() does not trigger the crash-handling path (no spurious respawn/warn)', async () => {
    const { client } = makeClient()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pending = client.embed('a') // spawns the worker
    pending.catch(() => {}) // close() rejects it below; avoid unhandled-rejection noise
    await client.close()
    expect(warn).not.toHaveBeenCalled()
    expect(client.isAvailable()).toBe(true)
    await expect(pending).rejects.toThrow(/shutting down/)
    warn.mockRestore()
  })
})
