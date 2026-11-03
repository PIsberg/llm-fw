import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { Worker } from 'node:worker_threads'
import { InferenceWorkerClient, WorkerUnavailableError, type WorkerFactory } from '../../src/detection/inferenceWorker.js'

// A minimal fake Worker: an EventEmitter with postMessage()/terminate(), so
// tests can drive message/error/exit events without spawning a real thread.
class FakeWorker extends EventEmitter {
  posted: { id: number; kind: string; text?: string; model?: string; spinWait?: boolean }[] = []
  terminated = false
  referenced = true
  ref(): void { this.referenced = true }
  unref(): void { this.referenced = false }
  postMessage(msg: { id: number; kind: string; text?: string; model?: string; spinWait?: boolean }): void {
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

  it('sends the spin setting with every embedding request, so a respawned worker keeps it', async () => {
    const { client, workers } = makeClient()
    void client.ensure('embed', { spinWait: true }).catch(() => {})
    void client.embed('text').catch(() => {})
    expect(workers[0]!.posted[0]).toMatchObject({ kind: 'ensure', model: 'embed', spinWait: true })
    expect(workers[0]!.posted[1]).toMatchObject({ kind: 'embed', spinWait: true })
    workers[0]!.emit('exit', 1)
    void client.embed('text again').catch(() => {})
    expect(workers[1]!.posted[0]).toMatchObject({ kind: 'embed', spinWait: true })
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

  describe('a worker that stops answering', () => {
    const STALL_MS = 1_000
    function stallClient() {
      const workers: FakeWorker[] = []
      const factory: WorkerFactory = vi.fn(() => {
        const w = new FakeWorker()
        workers.push(w)
        return w as unknown as Worker
      })
      return { client: new InferenceWorkerClient(factory, STALL_MS), workers }
    }
    const answer = (w: FakeWorker, i: number) => w.emit('message', { id: w.posted[i]!.id, ok: true, kind: 'embed', result: new Float32Array(1) })

    beforeEach(() => { vi.useFakeTimers() })
    afterEach(() => { vi.useRealTimers() })

    it('fails what it holds, ends it, and respawns for the next request', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { client, workers } = stallClient()
      const stuck = client.embed('one')
      const outcome = expect(stuck).rejects.toThrow(/no answer/)
      await vi.advanceTimersByTimeAsync(STALL_MS)
      await outcome
      expect(workers[0]!.terminated).toBe(true)
      void client.embed('two').catch(() => {})
      expect(workers).toHaveLength(2)
    })

    it('falls back to in-process after a second stall', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { client } = stallClient()
      for (let i = 0; i < 2; i++) {
        const outcome = expect(client.embed('text')).rejects.toThrow(/no answer/)
        await vi.advanceTimersByTimeAsync(STALL_MS)
        await outcome
      }
      expect(client.isAvailable()).toBe(false)
      await expect(client.embed('text')).rejects.toBeInstanceOf(WorkerUnavailableError)
    })

    it('counts any answer as progress, so a long queue is not a stall', async () => {
      const { client, workers } = stallClient()
      const all = [client.embed('a'), client.embed('b'), client.embed('c')]
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(STALL_MS - 1)
        answer(workers[0]!, i)
      }
      await expect(Promise.all(all)).resolves.toHaveLength(3)
      expect(workers[0]!.terminated).toBe(false)
    })

    it('stops watching once nothing is outstanding', async () => {
      const { client, workers } = stallClient()
      const done = client.embed('a')
      answer(workers[0]!, 0)
      await done
      await vi.advanceTimersByTimeAsync(STALL_MS * 5)
      expect(workers[0]!.terminated).toBe(false)
    })

    // A first download takes minutes. Its caller bounds it with modelLoadTimeoutMs.
    it('does not treat a model load as a stall', async () => {
      const { client, workers } = stallClient()
      void client.ensure('embed', { spinWait: false }).catch(() => {})
      await vi.advanceTimersByTimeAsync(STALL_MS * 5)
      expect(workers[0]!.terminated).toBe(false)
    })
  })

  // An idle worker must not keep a finished script alive, and one holding work must:
  // a script waiting only on an answer would otherwise exit with the scan unfinished.
  it('holds the process open only while it has work outstanding', async () => {
    const { client, workers } = makeClient()
    const pending = client.embed('text')
    const worker = workers[0]!
    expect(worker.referenced).toBe(true)
    worker.emit('message', { id: worker.posted[0]!.id, ok: true, kind: 'embed', result: new Float32Array(1) })
    await pending
    expect(worker.referenced).toBe(false)
    void client.embed('more').catch(() => {})
    expect(worker.referenced).toBe(true)
  })

  // One pipeline closing the shared client must not leave another, still using it,
  // with a worker whose crash is ignored and whose requests then wait for ever.
  it('after close(), a new worker\'s crash still fails what it holds', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { client, workers } = makeClient()
    void client.embed('before').catch(() => {})
    await client.close()
    const after = client.embed('after')
    expect(workers).toHaveLength(2)
    workers[1]!.emit('exit', 1)
    await expect(after).rejects.toThrow(/exited with code 1/)
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
