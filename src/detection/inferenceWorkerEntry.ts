import { parentPort } from 'node:worker_threads'
import { embedRaw, loadEmbeddingExtractor, type FeatureExtractor } from './embedding.js'
import { loadInjectionClassifier, type ClassifyFn } from './classifier.js'
import { cachedLoad } from './modelLoad.js'
import { loadModerationClassifier } from './outputClassifier.js'
import { loadTranscriber, runTranscriber, type Transcriber } from './transcribe.js'
import type { WorkerRequestMessage } from './inferenceWorker.js'

/**
 * Task C3 — the code that actually runs INSIDE the persistent worker thread
 * when detection.workerInference is on (see inferenceWorker.ts for the
 * main-thread client that spawns/manages this file).
 *
 * Both models are lazy-loaded on first request, exactly like the in-process
 * path — this file reuses embedding.ts's/classifier.ts's own loader
 * functions and embedRaw() helper so the forward pass is the EXACT same
 * computation as in-process (same model id, same dtype, same "query:"
 * prefix, same single-text calls — never batched; see the q8 calibration
 * note in embedding.ts). That reuse is what guarantees numerically identical
 * results whether the flag is on or off.
 */

const port = parentPort
if (!port) {
  throw new Error('inferenceWorkerEntry.ts must be run inside a worker_threads Worker')
}

// One load each, shared by every request; a failed one is tried again after
// LOAD_RETRY_MS rather than failing every request for the worker's life (#869).
// The first request's options choose the extractor's, as before.
let extractorLoad: (() => Promise<FeatureExtractor>) | null = null
function getExtractor(spinWait: boolean, threads: number | undefined): Promise<FeatureExtractor> {
  extractorLoad ??= cachedLoad(() => loadEmbeddingExtractor(spinWait, threads))
  return extractorLoad()
}

const getClassifier: () => Promise<ClassifyFn> = cachedLoad(loadInjectionClassifier)

// The response moderation classifier, one load per model id, and the
// transcriber: off the main thread too (#869).
const moderators = new Map<string, () => Promise<ClassifyFn>>()
function getModerator(modelId: string): Promise<ClassifyFn> {
  let get = moderators.get(modelId)
  if (!get) { get = cachedLoad(() => loadModerationClassifier(modelId)); moderators.set(modelId, get) }
  return get()
}
const getTranscriber: () => Promise<Transcriber> = cachedLoad(loadTranscriber)

type WorkerRequest = WorkerRequestMessage & { id: number }

port.on('message', (msg: WorkerRequest) => {
  void (async () => {
    try {
      if (msg.kind === 'embed') {
        const extractor = await getExtractor(msg.spinWait === true, msg.threads)
        const result = await embedRaw(extractor, msg.text ?? '')
        port.postMessage({ id: msg.id, ok: true, kind: 'embed', result })
      } else if (msg.kind === 'classify') {
        const classifier = await getClassifier()
        const result = await classifier(msg.text ?? '')
        port.postMessage({ id: msg.id, ok: true, kind: 'classify', result })
      } else if (msg.kind === 'moderate') {
        const moderator = await getModerator(msg.modelId ?? '')
        const result = await moderator(msg.text ?? '')
        port.postMessage({ id: msg.id, ok: true, kind: 'moderate', result })
      } else if (msg.kind === 'transcribe') {
        const result = await runTranscriber(await getTranscriber(), msg.audio ?? new Float32Array(0))
        port.postMessage({ id: msg.id, ok: true, kind: 'transcribe', result })
      } else {
        // 'ensure' — lazily load a model without running inference on any
        // text, used by init() to probe availability.
        if (msg.model === 'embed') await getExtractor(msg.spinWait === true, msg.threads)
        else if (msg.model === 'moderate') await getModerator(msg.modelId ?? '')
        else if (msg.model === 'transcribe') await getTranscriber()
        else await getClassifier()
        port.postMessage({ id: msg.id, ok: true, kind: 'ensure' })
      }
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: (err as Error).message })
    }
  })()
})
