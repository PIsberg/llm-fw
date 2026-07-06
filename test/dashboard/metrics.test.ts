import { describe, it, expect } from 'vitest'
import { MetricsRegistry } from '../../src/dashboard/metrics.js'

describe('MetricsRegistry — Prometheus text exposition', () => {
  it('emits valid HELP/TYPE preambles for every series, even with no data recorded', () => {
    const registry = new MetricsRegistry()
    const text = registry.render({ embedding: false, classifier: false })

    for (const name of ['llmfw_requests_total', 'llmfw_blocks_total', 'llmfw_warns_total', 'llmfw_events_total', 'llmfw_scan_duration_ms', 'llmfw_model_loaded']) {
      expect(text).toContain(`# HELP ${name} `)
      expect(text).toMatch(new RegExp(`# TYPE ${name} (counter|histogram|gauge)`))
    }
    // Histogram scaffolding is always present (even with zero observations):
    // one _bucket line per configured boundary plus the mandatory +Inf bucket.
    for (const le of [5, 10, 25, 50, 100, 250, 500, 1000, 2500]) {
      expect(text).toContain(`llmfw_scan_duration_ms_bucket{le="${le}"} 0`)
    }
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="+Inf"} 0')
    expect(text).toContain('llmfw_scan_duration_ms_sum 0')
    expect(text).toContain('llmfw_scan_duration_ms_count 0')
  })

  it('counts blocks/warns by stage and events by kind from recordEvent()', () => {
    const registry = new MetricsRegistry()
    registry.recordEvent({ action: 'blocked', stage: 'heuristic', kind: 'prompt' })
    registry.recordEvent({ action: 'blocked', stage: 'heuristic', kind: 'prompt' })
    registry.recordEvent({ action: 'blocked', stage: 'embedding', kind: 'prompt' })
    registry.recordEvent({ action: 'warned', stage: 'crescendo', kind: 'crescendo' })
    registry.recordEvent({ action: 'passed', stage: 'mcp-filter', kind: 'mcp' })

    const text = registry.render({ embedding: true, classifier: false })
    expect(text).toContain('llmfw_blocks_total{stage="heuristic"} 2')
    expect(text).toContain('llmfw_blocks_total{stage="embedding"} 1')
    expect(text).toContain('llmfw_warns_total{stage="crescendo"} 1')
    // A 'passed' action never bumps blocks/warns...
    expect(text).not.toContain('stage="mcp-filter"} ')
    // ...but every emitted event (any action) bumps events_total by kind.
    expect(text).toContain('llmfw_events_total{kind="prompt"} 3')
    expect(text).toContain('llmfw_events_total{kind="crescendo"} 1')
    expect(text).toContain('llmfw_events_total{kind="mcp"} 1')
  })

  it('falls back to kind="unspecified" when the event carries no kind', () => {
    const registry = new MetricsRegistry()
    registry.recordEvent({ action: 'blocked', stage: 'dos' })
    const text = registry.render({ embedding: false, classifier: false })
    expect(text).toContain('llmfw_events_total{kind="unspecified"} 1')
    expect(text).toContain('llmfw_blocks_total{stage="dos"} 1')
  })

  it('recordScan() increments requests_total by surface and observes the duration histogram cumulatively', () => {
    const registry = new MetricsRegistry()
    registry.recordScan('proxy', 3)   // <= every bucket incl. 5
    registry.recordScan('proxy', 40)  // <= 50, 100, ... but not 5/10/25
    registry.recordScan('playground', 9000) // only <= +Inf

    const text = registry.render({ embedding: false, classifier: false })
    expect(text).toContain('llmfw_requests_total{surface="proxy"} 2')
    expect(text).toContain('llmfw_requests_total{surface="playground"} 1')

    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="5"} 1')
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="10"} 1')
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="25"} 1')
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="50"} 2')
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="2500"} 2')
    expect(text).toContain('llmfw_scan_duration_ms_bucket{le="+Inf"} 3')
    expect(text).toContain('llmfw_scan_duration_ms_sum 9043')
    expect(text).toContain('llmfw_scan_duration_ms_count 3')
  })

  it('reflects model-loaded gauges passed in at scrape time (not cached)', () => {
    const registry = new MetricsRegistry()
    expect(registry.render({ embedding: false, classifier: false })).toContain('llmfw_model_loaded{model="embedding"} 0')
    expect(registry.render({ embedding: true, classifier: false })).toContain('llmfw_model_loaded{model="embedding"} 1')
    expect(registry.render({ embedding: true, classifier: true })).toContain('llmfw_model_loaded{model="classifier"} 1')
  })

  it('escapes double quotes and backslashes in label values', () => {
    const registry = new MetricsRegistry()
    registry.recordEvent({ action: 'blocked', stage: 'weird"stage\\name' })
    const text = registry.render({ embedding: false, classifier: false })
    expect(text).toContain('llmfw_blocks_total{stage="weird\\"stage\\\\name"} 1')
  })
})
