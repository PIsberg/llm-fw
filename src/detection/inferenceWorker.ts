import { Worker } from 'node:worker_threads'

/**
 * Task C3 — main-thread client for opt-in worker_threads inference isolation
 * (detection.workerInference, default FALSE). When the flag is on,
 * EmbeddingChecker / InjectionClassifier route their model forward passes
 * through the SINGLE persistent worker thread this module manages instead of
 * calling @huggingface/transformers in-process — see inferenceWorkerEntry.ts
 * for the code that actually runs inside the worker.
 *
 * CRITICAL — the q8 calibration rule (embedding.ts): every request carries
 * exactly one text, mirroring the in-process call shape bit-for-bit. Never
 * batch requests to the worker; batching shifts the quantized forward pass
 * and would silently de-calibrate the tuned thresholds.
 *
 * Crash policy: a worker death rejects every in-flight request (never leaves
 * a caller hanging — those rejections propagate like any other pipeline
 * error, so detection.failMode / the classifier's existing null-on-error
 * contract applies as usual) and respawns lazily on the next request. A
 * SECOND death disables the worker permanently for this process; callers
 * then fall back to loading the model in-process themselves (see
 * WorkerUnavailableError below).
 */

export type WorkerFactory = (url: URL, options: { execArgv: string[] }) => Worker

interface EmbedResponse { id: number; ok: true; kind: 'embed'; result: Float32Array }
interface ClassifyResponse { id: number; ok: true; kind: 'classify'; result: { label: string; score: number }[] }
interface EnsureResponse { id: number; ok: true; kind: 'ensure' }
interface ErrorResponse { id: number; ok: false; error: string }
type WorkerResponse = EmbedResponse | ClassifyResponse | EnsureResponse | ErrorResponse

interface PendingRequest {
  resolve: (r: WorkerResponse) => void
  reject: (err: Error) => void
}

/**
 * Thrown when the worker has permanently fallen back to in-process (second
 * crash). Callers (embedding.ts / classifier.ts) catch this SPECIFIC error
 * type to switch to the in-process path for all future calls — it is never
 * surfaced as a scan failure, unlike a generic crash-time rejection.
 */
export class WorkerUnavailableError extends Error {
  constructor() {
    super('inference worker permanently unavailable — using in-process fallback')
    this.name = 'WorkerUnavailableError'
  }
}

/**
 * tsx/vitest execute the .ts source directly, so `import.meta.url` for THIS
 * module ends in `.ts`; the built CLI runs compiled .js from dist, where it
 * ends in `.js`. Node's worker_threads Worker needs a loader that understands
 * whichever one is on disk next to it:
 *   - dev (.ts): pass tsx's ESM loader via execArgv — the pattern tsx itself
 *     documents for worker threads, and the same `--import tsx/esm` this repo
 *     already uses for other dev-time entry points (see package.json's
 *     test:load:perf / scorecard scripts).
 *   - built (.js): dist/ is already plain compiled JS (this package's
 *     "type": "module" makes Node load it as ESM with no extra flags).
 */
function resolveWorkerEntry(): { url: URL; execArgv: string[] } {
  const isSource = import.meta.url.endsWith('.ts')
  return {
    url: new URL(isSource ? './inferenceWorkerEntry.ts' : './inferenceWorkerEntry.js', import.meta.url),
    execArgv: isSource ? ['--import', 'tsx/esm'] : [],
  }
}

const defaultWorkerFactory: WorkerFactory = (url, options) => new Worker(url, options)

export class InferenceWorkerClient {
  private worker: Worker | null = null
  private readonly handledCrash = new WeakSet<Worker>()
  private readonly pending = new Map<number, PendingRequest>()
  private nextId = 1
  private crashCount = 0
  private permanentlyDisabled = false
  private terminating = false

  constructor(private readonly workerFactory: WorkerFactory = defaultWorkerFactory) {}

  /** False once the worker has crashed twice — callers should use the
   *  in-process fallback instead of calling embed()/classify()/ensure(). */
  isAvailable(): boolean {
    return !this.permanentlyDisabled
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker
    const { url, execArgv } = resolveWorkerEntry()
    const worker = this.workerFactory(url, { execArgv })
    worker.on('message', (msg: WorkerResponse) => {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      if (msg.ok) pending.resolve(msg)
      else pending.reject(new Error(msg.error))
    })
    worker.on('error', (err: Error) => this.handleCrash(worker, err))
    worker.on('exit', (code) => {
      if (code !== 0) this.handleCrash(worker, new Error(`inference worker exited with code ${code}`))
    })
    this.worker = worker
    return worker
  }

  private handleCrash(worker: Worker, err: Error): void {
    // A deliberate close() also triggers 'exit'; ignore that. 'error' and
    // 'exit' can both fire for the SAME crash — handle it only once.
    if (this.terminating || this.handledCrash.has(worker)) return
    this.handledCrash.add(worker)
    if (this.worker === worker) this.worker = null

    // Every request in flight on the dead worker must settle NOW — never
    // leave a caller hanging. Each rejection propagates like any other
    // pipeline error (detection.failMode applies at the proxy boundary for
    // the embedding stage; the classifier stage already swallows model
    // errors into a null verdict, same as any other classifier failure).
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(err)
    }

    this.crashCount++
    if (this.crashCount === 1) {
      console.warn(`[llm-fw] inference worker crashed (${err.message}) — respawning`)
    } else {
      this.permanentlyDisabled = true
      console.warn(`[llm-fw] inference worker crashed again (${err.message}) — falling back to in-process inference`)
    }
  }

  private request(req: { kind: 'embed' | 'classify' | 'ensure'; text?: string; model?: 'embed' | 'classify' }): Promise<WorkerResponse> {
    if (this.permanentlyDisabled) return Promise.reject(new WorkerUnavailableError())
    const worker = this.getWorker()
    const id = this.nextId++
    return new Promise<WorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      worker.postMessage({ ...req, id })
    })
  }

  /** Embed ONE text (never batched — see the q8 calibration note above). */
  async embed(text: string): Promise<Float32Array> {
    const res = await this.request({ kind: 'embed', text })
    if (res.ok && res.kind === 'embed') return res.result
    throw new Error('unexpected inference worker response for embed')
  }

  /** Classify ONE text, returning the raw model output array. */
  async classify(text: string): Promise<{ label: string; score: number }[]> {
    const res = await this.request({ kind: 'classify', text })
    if (res.ok && res.kind === 'classify') return res.result
    throw new Error('unexpected inference worker response for classify')
  }

  /** Lazily load a model in the worker without running inference on any
   *  text — used by init() to probe availability (mirrors the in-process
   *  catch-and-disable path around the initial pipeline() call). */
  async ensure(model: 'embed' | 'classify'): Promise<void> {
    const res = await this.request({ kind: 'ensure', model })
    if (!(res.ok && res.kind === 'ensure')) throw new Error('unexpected inference worker response for ensure')
  }

  /** Terminate the worker (shutdown hook). Safe to call when never spawned. */
  async close(): Promise<void> {
    this.terminating = true
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new Error('inference worker shutting down'))
    }
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}

let sharedClient: InferenceWorkerClient | null = null

/** Process-wide singleton — embedding + classifier share ONE worker thread. */
export function getInferenceWorkerClient(): InferenceWorkerClient {
  if (!sharedClient) sharedClient = new InferenceWorkerClient()
  return sharedClient
}

/** Terminate the shared worker (shutdown hook — see Pipeline.close()). */
export async function closeInferenceWorker(): Promise<void> {
  if (!sharedClient) return
  const client = sharedClient
  sharedClient = null
  await client.close()
}
