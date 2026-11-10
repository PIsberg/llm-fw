export type { CompetitorAdapter } from './adapter.js'
export { ProtectAiDebertaAdapter } from './protectai-deberta.js'
export { PromptGuardAdapter } from './prompt-guard.js'
export { LlamaGuardAdapter } from './llama-guard.js'
export { LakeraGuardAdapter } from './lakera.js'
export { LlmFwAdapter } from './llm-fw.js'

import { ProtectAiDebertaAdapter } from './protectai-deberta.js'
import { PromptGuardAdapter } from './prompt-guard.js'
import { LlamaGuardAdapter } from './llama-guard.js'
import { LakeraGuardAdapter } from './lakera.js'
import { LlmFwAdapter } from './llm-fw.js'
import type { CompetitorAdapter } from './adapter.js'

/** Fresh instances every call — adapters hold init state (loaded model,
 *  reachability cache), so each split/process gets a clean set. */
export function createAdapters(): CompetitorAdapter[] {
  return [
    new LlmFwAdapter('cheap'),
    new LlmFwAdapter('classifier-corroborated'),
    new LlmFwAdapter('classifier'),
    new ProtectAiDebertaAdapter(),
    new PromptGuardAdapter(),
    new LlamaGuardAdapter(),
    new LakeraGuardAdapter(),
  ]
}
