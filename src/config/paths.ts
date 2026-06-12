import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * The llm-fw state directory: CA material, persisted config, pid file,
 * whitelist, and model caches. Honours the LLM_FW_DIR environment variable
 * (evaluated at call time so tests can point it at a temp dir) and defaults
 * to ~/.llm-fw. Every consumer must resolve the directory through this
 * helper — partial LLM_FW_DIR support previously split state across two
 * directories (CA written to $LLM_FW_DIR, pid/config read from ~/.llm-fw).
 */
export function getLlmFwDir(): string {
  return process.env.LLM_FW_DIR || join(homedir(), '.llm-fw');
}
