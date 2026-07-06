import { parentPort } from 'node:worker_threads'
import { env } from '@huggingface/transformers'
import { join } from 'node:path'
import { getLlmFwDir } from '../config/paths.js'
import { embedRaw, loadEmbeddingExtractor, type FeatureExtractor } from './embedding.js'
import { loadInjectionClassifier, type ClassifyFn } from './classifier.js'

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

// Mirrors embedding.ts / classifier.ts's cache-dir resolution exactly (same
// env vars), so the worker reads from — and downloads into — the same model
// cache as the in-process path.
env.cacheDir = process.env.LLM_FW_MODEL_DIR || join(getLlmFwDir(), 'models')
env.allowLocalModels = false

let extractorPromise: Promise<FeatureExtractor> | null = null
function getExtractor(): Promise<FeatureExtractor> {
  if (!extractorPromise) extractorPromise = loadEmbeddingExtractor()
  return extractorPromise
}

let classifierPromise: Promise<ClassifyFn> | null = null
function getClassifier(): Promise<ClassifyFn> {
  if (!classifierPromise) classifierPromise = loadInjectionClassifier()
  return classifierPromise
}

interface WorkerRequest {
  id: number
  kind: 'embed' | 'classify' | 'ensure'
  text?: string
  model?: 'embed' | 'classify'
}

port.on('message', (msg: WorkerRequest) => {
  void (async () => {
    try {
      if (msg.kind === 'embed') {
        const extractor = await getExtractor()
        const result = await embedRaw(extractor, msg.text ?? '')
        port.postMessage({ id: msg.id, ok: true, kind: 'embed', result })
      } else if (msg.kind === 'classify') {
        const classifier = await getClassifier()
        const result = await classifier(msg.text ?? '')
        port.postMessage({ id: msg.id, ok: true, kind: 'classify', result })
      } else {
        // 'ensure' — lazily load a model without running inference on any
        // text, used by init() to probe availability.
        if (msg.model === 'embed') await getExtractor()
        else await getClassifier()
        port.postMessage({ id: msg.id, ok: true, kind: 'ensure' })
      }
    } catch (err) {
      port.postMessage({ id: msg.id, ok: false, error: (err as Error).message })
    }
  })()
})
