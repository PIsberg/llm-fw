/**
 * CPU and memory of this process while a load scenario runs (#598).
 *
 * The load harness runs the proxy, the mock upstream and the load generator in
 * one process, so these figures are the firewall plus a small, constant
 * harness overhead: compare runs with each other, not with a production RSS.
 */

export interface ResourceSample { t: number; rssMb: number; heapMb: number; cpuPct: number }

export interface ResourceReport {
  wallMs: number
  /** User plus system CPU time over the whole run. */
  cpuMs: number
  /** cpuMs over wallMs, as a percentage of one core (can exceed 100). */
  cpuPct: number
  peakRssMb: number
  peakHeapMb: number
  series: ResourceSample[]
}

const MB = 1024 * 1024
const round1 = (n: number): number => Math.round(n * 10) / 10

/** Start sampling every `intervalMs`; the returned function stops it and reports. */
export function startResourceSampler(intervalMs = 1000): () => ResourceReport {
  const t0 = performance.now()
  const cpu0 = process.cpuUsage()
  let lastT = t0
  let lastCpu = cpu0
  let peakRss = 0
  let peakHeap = 0
  const series: ResourceSample[] = []

  const sample = (): void => {
    const now = performance.now()
    const cpu = process.cpuUsage(lastCpu)
    const mem = process.memoryUsage()
    peakRss = Math.max(peakRss, mem.rss)
    peakHeap = Math.max(peakHeap, mem.heapUsed)
    const elapsed = now - lastT
    series.push({
      t: round1((now - t0) / 1000),
      rssMb: round1(mem.rss / MB),
      heapMb: round1(mem.heapUsed / MB),
      cpuPct: elapsed > 0 ? round1(((cpu.user + cpu.system) / 1000 / elapsed) * 100) : 0,
    })
    lastT = now
    lastCpu = process.cpuUsage()
  }

  const timer = setInterval(sample, intervalMs)
  timer.unref()

  return () => {
    clearInterval(timer)
    sample()
    const wallMs = performance.now() - t0
    const total = process.cpuUsage(cpu0)
    const cpuMs = (total.user + total.system) / 1000
    return {
      wallMs: Math.round(wallMs),
      cpuMs: Math.round(cpuMs),
      cpuPct: wallMs > 0 ? round1((cpuMs / wallMs) * 100) : 0,
      peakRssMb: round1(peakRss / MB),
      peakHeapMb: round1(peakHeap / MB),
      series,
    }
  }
}
