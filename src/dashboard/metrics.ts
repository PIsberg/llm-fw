import { BlockEvent } from '../types.js'

/**
 * Task C4 — hand-rolled Prometheus text-exposition registry (no new runtime
 * dependency; no `prom-client`). Three kinds of series:
 *
 *  - `llmfw_requests_total{surface}` / `llmfw_scan_duration_ms` (histogram) —
 *    fed by `recordScan()`, called once per `Pipeline.run()` invocation from
 *    the call boundary in proxy.ts (surface="proxy", live MITM traffic) and
 *    server.ts (surface="playground", the dashboard's Prompt Testing tab).
 *    Neither pipeline.ts nor proxy.ts tracks PER-STAGE timing today (checked
 *    both before writing this — there is no existing per-stage clock to
 *    reuse), and adding invasive per-stage instrumentation inside
 *    Pipeline.run() was explicitly out of scope for this task, so the
 *    histogram is OVERALL scan duration only.
 *  - `llmfw_blocks_total{stage}` / `llmfw_warns_total{stage}` /
 *    `llmfw_events_total{kind}` — fed by `recordEvent()`, called from
 *    EventBus.emit(), the single funnel every dashboard block/warn/audit
 *    event already passes through (Pipeline's onBlock callback, and every
 *    other scanner in proxy.ts: DLP, DoS, URL filter, MCP, taint,
 *    response-exfil, tool-use-exfil, etc).
 *  - `llmfw_model_loaded{model}` — a gauge read fresh at scrape time from
 *    Pipeline.getModelStatus() (embedding/classifier isInitialized()), never
 *    cached, so a model that finishes loading after startup is reflected on
 *    the very next scrape.
 */

// Prometheus histogram buckets are cumulative ("le" = less-than-or-equal).
const DURATION_BUCKETS_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500] as const

export interface ModelStatus {
  embedding: boolean;
  classifier: boolean;
}

export class MetricsRegistry {
  private requestsTotal = new Map<string, number>()
  private blocksTotal = new Map<string, number>()
  private warnsTotal = new Map<string, number>()
  private eventsTotal = new Map<string, number>()
  // Cumulative bucket counts, parallel to DURATION_BUCKETS_MS: index i counts
  // every observation <= DURATION_BUCKETS_MS[i].
  private durationBucketCounts = new Array<number>(DURATION_BUCKETS_MS.length).fill(0)
  private durationSum = 0
  private durationCount = 0

  private static bump(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1)
  }

  /**
   * Called once per Pipeline.run() invocation, timed at the call boundary by
   * the caller (proxy.ts / server.ts) — this class does no timing itself.
   */
  recordScan(surface: string, durationMs: number): void {
    MetricsRegistry.bump(this.requestsTotal, surface)
    this.durationSum += durationMs
    this.durationCount += 1
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      if (durationMs <= DURATION_BUCKETS_MS[i]) this.durationBucketCounts[i] += 1
    }
  }

  /** Called from EventBus.emit() — see the class doc comment above. */
  recordEvent(event: Pick<BlockEvent, 'action' | 'stage' | 'kind'>): void {
    if (event.action === 'blocked') MetricsRegistry.bump(this.blocksTotal, event.stage)
    else if (event.action === 'warned') MetricsRegistry.bump(this.warnsTotal, event.stage)
    MetricsRegistry.bump(this.eventsTotal, event.kind ?? 'unspecified')
  }

  /** Render the full Prometheus text exposition for a GET /metrics scrape. */
  render(modelStatus: ModelStatus): string {
    const lines: string[] = []

    lines.push('# HELP llmfw_requests_total Total requests scanned by the detection pipeline, by entry surface.')
    lines.push('# TYPE llmfw_requests_total counter')
    for (const [surface, count] of this.requestsTotal) {
      lines.push(`llmfw_requests_total{surface="${escapeLabel(surface)}"} ${count}`)
    }

    lines.push('# HELP llmfw_blocks_total Total requests blocked, by detection stage.')
    lines.push('# TYPE llmfw_blocks_total counter')
    for (const [stage, count] of this.blocksTotal) {
      lines.push(`llmfw_blocks_total{stage="${escapeLabel(stage)}"} ${count}`)
    }

    lines.push('# HELP llmfw_warns_total Total requests warned (audit-mode or weak-signal), by detection stage.')
    lines.push('# TYPE llmfw_warns_total counter')
    for (const [stage, count] of this.warnsTotal) {
      lines.push(`llmfw_warns_total{stage="${escapeLabel(stage)}"} ${count}`)
    }

    lines.push('# HELP llmfw_events_total Total dashboard events emitted, by event kind.')
    lines.push('# TYPE llmfw_events_total counter')
    for (const [kind, count] of this.eventsTotal) {
      lines.push(`llmfw_events_total{kind="${escapeLabel(kind)}"} ${count}`)
    }

    lines.push('# HELP llmfw_scan_duration_ms Pipeline scan duration in milliseconds (overall — see source comment for why there is no per-stage breakdown).')
    lines.push('# TYPE llmfw_scan_duration_ms histogram')
    for (let i = 0; i < DURATION_BUCKETS_MS.length; i++) {
      lines.push(`llmfw_scan_duration_ms_bucket{le="${DURATION_BUCKETS_MS[i]}"} ${this.durationBucketCounts[i]}`)
    }
    lines.push(`llmfw_scan_duration_ms_bucket{le="+Inf"} ${this.durationCount}`)
    lines.push(`llmfw_scan_duration_ms_sum ${this.durationSum}`)
    lines.push(`llmfw_scan_duration_ms_count ${this.durationCount}`)

    lines.push('# HELP llmfw_model_loaded Whether a detection model is loaded and ready (1) or not (0).')
    lines.push('# TYPE llmfw_model_loaded gauge')
    lines.push(`llmfw_model_loaded{model="embedding"} ${modelStatus.embedding ? 1 : 0}`)
    lines.push(`llmfw_model_loaded{model="classifier"} ${modelStatus.classifier ? 1 : 0}`)

    return lines.join('\n') + '\n'
  }
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
}
