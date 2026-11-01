import { describe, it, expect } from 'vitest'
import {
  summarizeLatencies,
  cpuPctBetween,
  countStatuses,
  chatBody,
  agentBody,
  attackBody,
  parseLevels,
  machineLoad,
  speedDrift,
} from './lib/benchStats.js'

// The load benchmark (npm run bench:load) sweeps concurrency against a
// firewall in its own process. These pin the arithmetic its report and charts
// are built from, and the request shapes it sends.
describe('summarizeLatencies', () => {
  it('reports count, mean and nearest-rank percentiles', () => {
    const s = summarizeLatencies(Array.from({ length: 100 }, (_, i) => 100 - i))
    expect(s).toEqual({ count: 100, meanMs: 50.5, p50Ms: 50, p90Ms: 90, p95Ms: 95, p99Ms: 99, maxMs: 100 })
  })

  it('is all zeros on an empty step rather than NaN', () => {
    expect(summarizeLatencies([])).toEqual({ count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 })
  })
})

describe('cpuPctBetween', () => {
  it('is CPU time over wall time, as a percentage of one core', () => {
    // 1.5 s of CPU (microseconds) in 1 s of wall time: 150% of one core.
    expect(cpuPctBetween({ wallMs: 1000, cpuMicros: 2_000_000 }, { wallMs: 2000, cpuMicros: 3_500_000 })).toBe(150)
  })

  it('is zero when no wall time passed', () => {
    expect(cpuPctBetween({ wallMs: 5, cpuMicros: 1 }, { wallMs: 5, cpuMicros: 9 })).toBe(0)
  })
})

describe('machineLoad', () => {
  // Two cores; core 0 busy 600 of 1000 ms, core 1 busy 200 of 1000 ms.
  const before = [
    { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
    { times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 } },
  ]
  const after = [
    { times: { user: 500, nice: 0, sys: 100, idle: 400, irq: 0 } },
    { times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 } },
  ]

  it('splits machine-wide CPU into firewall, load generator and everything else', () => {
    // Firewall used 50% of one core, the generator 20%: of two cores, 25% and 10%.
    expect(machineLoad(before, after, 50, 20)).toEqual({ busyPct: 40, firewallPct: 25, generatorPct: 10, otherPct: 5 })
  })

  it('never reports negative other load from sampling skew', () => {
    expect(machineLoad(before, after, 70, 20).otherPct).toBe(0)
  })
})

describe('speedDrift', () => {
  it('is the slowest probe over the fastest, as a percentage slower', () => {
    expect(speedDrift([100, 125, 110])).toBe(25)
  })

  it('is zero with fewer than two probes', () => {
    expect(speedDrift([100])).toBe(0)
  })
})

describe('countStatuses', () => {
  it('counts each HTTP status', () => {
    expect(countStatuses([200, 200, 403, 422, 200])).toEqual({ '200': 3, '403': 1, '422': 1 })
  })
})

describe('request shapes', () => {
  it('gives every chat request new text, so the item cache cannot answer it', () => {
    const a = JSON.parse(chatBody(['Explain TCP.'], 1))
    const b = JSON.parse(chatBody(['Explain TCP.'], 2))
    expect(a.messages[0].content).toContain('Explain TCP.')
    expect(a.messages[0].content).not.toBe(b.messages[0].content)
  })

  it('builds an agent request near the requested size whose newest tool result is new each time', () => {
    const a = agentBody(['Explain TCP.'], 1, 64)
    const b = agentBody(['Explain TCP.'], 2, 64)
    expect(Buffer.byteLength(a)).toBeGreaterThan(60 * 1024)
    expect(Buffer.byteLength(a)).toBeLessThan(72 * 1024)
    const ma = JSON.parse(a).messages
    const mb = JSON.parse(b).messages
    // The history is byte-identical between requests, as an agent resends it.
    expect(JSON.stringify(ma.slice(0, -1))).toBe(JSON.stringify(mb.slice(0, -1)))
    // Only the newest turn, a tool result, differs.
    const last = ma[ma.length - 1]
    expect(last.role).toBe('user')
    expect(last.content[0].type).toBe('tool_result')
    expect(JSON.stringify(last)).not.toBe(JSON.stringify(mb[mb.length - 1]))
  })

  it('sends an attack prompt as the newest user message', () => {
    const body = JSON.parse(attackBody([{ prompt: 'p1' }, { prompt: 'p2' }], 3))
    expect(body.messages).toEqual([{ role: 'user', content: 'p2' }])
  })
})

describe('parseLevels', () => {
  it('reads a comma list of positive integers', () => {
    expect(parseLevels('1, 4,16', [2])).toEqual([1, 4, 16])
  })

  it('falls back to the default when unset and refuses a bad level', () => {
    expect(parseLevels(undefined, [2, 8])).toEqual([2, 8])
    expect(() => parseLevels('1,zero', [2])).toThrow(/zero/)
    expect(() => parseLevels('0', [2])).toThrow(/0/)
  })
})
