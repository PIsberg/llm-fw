/**
 * The local worker that reads a large tool result and lists its facts, and
 * the checks on its answer. Stub: every function throws or rejects until it is written.
 */

export const WORKER_INSTRUCTIONS: string = ''

export function isLocalWorkerUrl(_url: string): boolean {
  throw new Error('isLocalWorkerUrl is not implemented')
}

export function numberLines(_text: string): string {
  throw new Error('numberLines is not implemented')
}

export function textSize(_text: string): { lines: number; chars: number } {
  throw new Error('textSize is not implemented')
}

export function renderCondensed(_original: string, _facts: string, _path: string): string {
  throw new Error('renderCondensed is not implemented')
}

export function citationsValid(_facts: string, _original: string): boolean {
  throw new Error('citationsValid is not implemented')
}

export type WorkerProblem = 'no-worker' | 'not-local' | 'error' | 'partial-input'

export type CondenseOutcome =
  | { text: string; tokensIn: number; tokensOut: number }
  | { reason: 'worker-failed'; problem: WorkerProblem; read?: number; sent?: number }
  | { reason: 'rejected'; tokensIn: number; tokensOut: number }

export function condense(
  _original: string,
  _path: string,
  _worker: { url: string; model: string },
  _deadline: number,
  _fetchImpl?: typeof fetch,
): Promise<CondenseOutcome> {
  return Promise.reject(new Error('condense is not implemented'))
}
