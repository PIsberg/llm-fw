/**
 * Download the detection models into the image at build time.
 *
 * Without this, the first request after every rollout pays a ~30 MB download
 * and the container cannot run at all on an air-gapped network. Running one
 * real scan (rather than just constructing the pipeline) is deliberate: it
 * forces the lazy model load that a plain init would defer.
 *
 * Only the always-on embedding model is warmed. The optional classifiers are
 * ~700 MB and ~330 MB and are off by default, so baking them in would multiply
 * the image size for a feature most deployments never enable. Set
 * LLM_FW_WARM_CLASSIFIER=true at build time to include the injection
 * classifier when you know you will turn it on.
 */
import { createFirewall } from '../dist/index.js';

const warmClassifier = process.env.LLM_FW_WARM_CLASSIFIER === 'true';

const firewall = await createFirewall(
  warmClassifier ? { detection: { classifier: { enabled: true } } } : undefined,
);

// A scan that exercises the embedding stage, not just the heuristics: a plain
// "hello" short-circuits before the model is ever touched.
const verdict = await firewall.scan({
  text: 'Please summarise the attached quarterly report and list the three largest risks.',
});

await firewall.close();

console.log(
  `[warm] models cached in ${process.env.LLM_FW_MODEL_DIR ?? '<default>'} ` +
  `(probe verdict: ${verdict.action}/${verdict.stage}, classifier: ${warmClassifier})`,
);
