// Prove the BUILT package's inference worker answers (#671). Run after
// `npm run build`, with the model available.
//
// From source the worker needs tsx, and tsx in a worker fails on Node 22, so the
// test suite takes the in-process fallback there and never exercises it. The
// built package needs no tsx. A worker that cannot start falls back without a
// failure, since detection still works, so only the performance would be lost
// and nothing would say so. This counts the worker's own answers.
import { DEFAULT_CONFIG } from '../dist/config/config.js'
import { EmbeddingChecker } from '../dist/detection/embedding.js'
import { getInferenceWorkerClient } from '../dist/detection/inferenceWorker.js'

const client = getInferenceWorkerClient()
const embed = client.embed.bind(client)
let answers = 0
client.embed = async text => {
  const vector = await embed(text)
  if (vector.length > 0) answers++
  return vector
}

const checker = new EmbeddingChecker(
  { ...DEFAULT_CONFIG.detection, workerInference: process.env.SMOKE_WORKER_OFF !== 'true' },
  client,
)
await checker.init()
await checker.check('Please summarize the release notes for the parser.')
await client.close()

if (answers === 0) {
  console.error(`the inference worker never answered on Node ${process.version}: every scan took the in-process fallback`)
  process.exit(1)
}
console.log(`the inference worker answered ${answers} time(s) on Node ${process.version}`)
process.exit(0)
