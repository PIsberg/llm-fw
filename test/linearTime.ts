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
 * The fastest of up to `maxRuns` runs of `work`, stopping at the first run
 * under `ceilingMs`. Fastest of three was not enough: on 2026-11-10 one full
 * local unit run still took 560 ms against a 500 ms ceiling on the best of
 * three (`responseExfil.test.ts`, 400 KB of `<IMG SRC=`), and the same case
 * alone takes a fraction of that. A burst spanning ten runs is rarer still,
 * a passing case still runs once, and a quadratic scan is over the ceiling on
 * every run, so it still fails, only after `maxRuns` tries.
 */
export function underMs(ceilingMs: number, work: () => unknown, maxRuns = 10): number {
  let best = Number.POSITIVE_INFINITY
  for (let i = 0; i < maxRuns && best >= ceilingMs; i++) {
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
