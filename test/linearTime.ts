/**
 * Timing for the linear-time tests (#754).
 *
 * A linear-time test runs a scan over a few hundred KB and asserts it finished
 * in a fraction of what a quadratic scan of the same input takes. On one
 * developer machine the full unit suite runs about 230 files in parallel
 * workers, and one run in a few then took 1.3 s against a 500 ms ceiling, or
 * a case of six such scans passed vitest's 5 s default; alone, every one of
 * them passed in a fraction of that. A load burst rarely lands on three runs
 * in a row; a quadratic scan is slow on every run, so the fastest of three
 * keeps the ceiling's meaning without its noise.
 */
export function fastestMs(work: () => unknown, runs = 3): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < runs; i++) {
    const started = performance.now()
    work()
    best = Math.min(best, performance.now() - started)
  }
  return best
}

/**
 * The per-test budget for a case that times several large inputs. It bounds a
 * hang; the assertion inside is what states the property.
 */
export const LINEAR_TIME_TIMEOUT = 60_000
