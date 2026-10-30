import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { shouldIsolate } from '../../scripts/run-benchmark.js'

/**
 * #538: the classifier presets crashed silently (OOM) running every split in
 * one Node process, so their numbers in docs/BENCHMARK.md went stale. The
 * runner now gives each split its own process when it would otherwise run
 * the classifier over several of them.
 */

describe('shouldIsolate', () => {
  it('isolates a classifier preset over more than one split', () => {
    expect(shouldIsolate('classifier', [], 9)).toBe(true)
    expect(shouldIsolate('classifier-indirect', [], 2)).toBe(true)
  })

  it('keeps one split, or the cheap presets, in process', () => {
    expect(shouldIsolate('classifier', [], 1)).toBe(false)
    expect(shouldIsolate('cheap', [], 9)).toBe(false)
  })

  it('follows --isolate and --no-isolate, and never recurses from a child', () => {
    expect(shouldIsolate('cheap', ['--isolate'], 2)).toBe(true)
    expect(shouldIsolate('classifier', ['--no-isolate'], 9)).toBe(false)
    expect(shouldIsolate('classifier', ['--child'], 9)).toBe(false)
  })
})

describe('run-benchmark --isolate', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['--import', 'tsx/esm', 'scripts/run-benchmark.ts', 'cheap', '--json', '--only=heldout,gandalf-ignore-instructions', ...args], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  })) as { isolated?: boolean; datasets: Array<Record<string, unknown>> }
  const counts = (out: ReturnType<typeof run>) => out.datasets.map(({ p50Ms: _p50, ...rest }) => rest)

  it('gives the same verdicts split by split as one process', () => {
    const together = run()
    const isolated = run('--isolate')
    expect(together.isolated).toBe(false)
    expect(isolated.isolated).toBe(true)
    expect(counts(isolated)).toEqual(counts(together))
    expect(isolated.datasets.map(d => d.name)).toEqual(['gandalf-ignore-instructions', 'heldout'])
  }, 240_000)
})
