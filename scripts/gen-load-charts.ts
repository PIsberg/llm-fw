/**
 * Generate SVG charts from load test JSON results.
 *
 * Usage:
 *   node --import tsx/esm scripts/gen-load-charts.ts <perf.json> <accuracy.json>
 *
 * Writes four SVG files next to the JSON files.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'

// ── Types ─────────────────────────────────────────────────────────────────────
interface PerfResult {
  scenario: 'performance'
  timestamp: string
  config: { vus: number; durationS: number; p99ThresholdMs: number }
  results: {
    totalRequests: number
    throughputRps: number
    latencyPercentiles: { p50: number; p95: number; p99: number }
    falsePositives: number
    fpr: number
    errors: number
    errRate: number
    timeSeries: { second: number; rps: number; p50Ms: number; p95Ms: number }[]
  }
  passed: boolean
}

interface AccuracyResult {
  scenario: 'accuracy'
  timestamp: string
  config: { vus: number; iterations: number; benignRatio: number; fprMax: number; tprMin: number }
  results: {
    confusionMatrix: { tn: number; fp: number; tp: number; fn: number }
    fpr: number
    tpr: number
    avgLatencyMs: number
    p50LatencyMs: number
    p95LatencyMs: number
    p99LatencyMs: number
    errCount: number
  }
  passed: boolean
}

// ── Design tokens ─────────────────────────────────────────────────────────────
const W = 760
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif`
const C = {
  blue:        '#1565c0',
  blueLight:   '#bbdefb',
  blueMid:     '#1976d2',
  red:         '#c62828',
  redLight:    '#ffcdd2',
  green:       '#2e7d32',
  greenLight:  '#c8e6c9',
  orange:      '#e65100',
  orangeLight: '#ffe0b2',
  purple:      '#6a1b9a',
  purpleLight: '#e1bee7',
  gray:        '#757575',
  gridLine:    '#eeeeee',
  axisLine:    '#bdbdbd',
  bg:          '#ffffff',
  cardBg:      '#fafafa',
  border:      '#e0e0e0',
  title:       '#212121',
  subtitle:    '#616161',
  pass:        '#2e7d32',
  fail:        '#c62828',
}

// ── Low-level SVG helpers ─────────────────────────────────────────────────────
function xe(s: string | number): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function attr(a: Record<string, string | number | undefined>): string {
  return Object.entries(a)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${xe(v!)}"`)
    .join(' ')
}
function rect(a: {
  x: number; y: number; w: number; h: number
  fill?: string; stroke?: string; rx?: number; opacity?: number
}): string {
  return `<rect ${attr({ x: a.x, y: a.y, width: a.w, height: a.h, fill: a.fill ?? C.blue, stroke: a.stroke, rx: a.rx, opacity: a.opacity })} />`
}
function text(
  x: number, y: number, s: string | number,
  a: {
    size?: number; weight?: string; fill?: string; anchor?: string
    family?: string; opacity?: number
  } = {}
): string {
  return `<text ${attr({
    x, y,
    'font-size': a.size ?? 13,
    'font-weight': a.weight,
    'font-family': a.family ?? FONT,
    fill: a.fill ?? C.title,
    'text-anchor': a.anchor ?? 'start',
    opacity: a.opacity,
  })}>${xe(s)}</text>`
}
function line(x1: number, y1: number, x2: number, y2: number,
  a: { stroke?: string; width?: number; dash?: string } = {}
): string {
  return `<line ${attr({ x1, y1, x2, y2, stroke: a.stroke ?? C.gridLine, 'stroke-width': a.width ?? 1, 'stroke-dasharray': a.dash })} />`
}
function polyline(points: [number, number][], a: { stroke?: string; fill?: string; width?: number } = {}): string {
  const pts = points.map(([x, y]) => `${x},${y}`).join(' ')
  return `<polyline points="${pts}" stroke="${a.stroke ?? C.blue}" fill="${a.fill ?? 'none'}" stroke-width="${a.width ?? 2}" stroke-linejoin="round" stroke-linecap="round" />`
}
function svgWrap(h: number, inner: string): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}">`,
    `<style>text { font-family: ${FONT}; }</style>`,
    // Background
    rect({ x: 0, y: 0, w: W, h, fill: C.bg }),
    inner,
    `</svg>`,
  ].join('\n')
}

// ── Chart header ──────────────────────────────────────────────────────────────
function chartHeader(title: string, subtitle: string, passed?: boolean, y = 28): string {
  const badge = passed === undefined ? '' :
    `<rect x="${W - 100}" y="${y - 18}" width="88" height="24" rx="12" fill="${passed ? C.greenLight : C.redLight}" />` +
    text(W - 56, y - 1, passed ? '✓ PASSED' : '✗ FAILED', {
      size: 11, weight: '700', fill: passed ? C.pass : C.fail, anchor: 'middle'
    })
  return [
    badge,
    text(W / 2, y, title, { size: 17, weight: '700', fill: C.title, anchor: 'middle' }),
    text(W / 2, y + 20, subtitle, { size: 12, fill: C.subtitle, anchor: 'middle' }),
    line(40, y + 30, W - 40, y + 30, { stroke: C.border }),
  ].join('\n')
}

// ── Y-axis grid helper ────────────────────────────────────────────────────────
function yGrid(
  ox: number, oy: number, cw: number, ch: number,
  maxVal: number, steps: number,
  fmt: (v: number) => string
): string {
  const out: string[] = []
  for (let i = 0; i <= steps; i++) {
    const val = (maxVal / steps) * i
    const y   = oy + ch - (i / steps) * ch
    out.push(line(ox, y, ox + cw, y, { stroke: i === 0 ? C.axisLine : C.gridLine, width: i === 0 ? 1.5 : 1 }))
    out.push(text(ox - 8, y + 4, fmt(val), { size: 11, fill: C.gray, anchor: 'end' }))
  }
  return out.join('\n')
}

// ── Chart 1: Latency Distribution ────────────────────────────────────────────
function chartLatencyDistribution(d: PerfResult): string {
  const H = 400
  const ox = 75, oy = 80, cw = W - ox - 50, ch = 240

  const bars = [
    { label: 'p50', value: d.results.latencyPercentiles.p50, fill: C.green,  light: C.greenLight },
    { label: 'p95', value: d.results.latencyPercentiles.p95, fill: C.blue,   light: C.blueLight  },
    { label: 'p99', value: d.results.latencyPercentiles.p99, fill: C.red,    light: C.redLight   },
  ]
  const threshold = d.config.p99ThresholdMs
  // Scale y-axis to actual values so bars are visible, not driven by the ceiling.
  const maxVal = Math.max(...bars.map(b => b.value)) * 1.45
  const barW   = 90
  const step   = (cw - bars.length * barW) / (bars.length + 1)

  const yv = (v: number) => oy + ch - (v / maxVal) * ch
  const steps = 5

  const out: string[] = [
    chartHeader(
      'Response Latency Percentiles',
      `${d.config.vus} VUs · ${d.config.durationS}s duration · ${d.results.totalRequests} requests`,
      d.passed
    ),
    yGrid(ox, oy, cw, ch, maxVal, steps, v => `${Math.round(v)} ms`),
  ]

  // Threshold annotation — show as text if above chart scale, line if within scale
  const thresholdInScale = threshold <= maxVal
  if (thresholdInScale) {
    const ty = yv(threshold)
    out.push(line(ox, ty, ox + cw, ty, { stroke: C.red, width: 1.5, dash: '6,4' }))
    out.push(text(ox + cw + 4, ty + 4, `ceiling: ${threshold} ms`, { size: 10, fill: C.red }))
  } else {
    // Threshold is far above — just annotate
    out.push(text(ox + cw - 4, oy + 14,
      `p99 ceiling: ${threshold} ms — well above actual values`, { size: 10, fill: C.green, anchor: 'end' }))
  }

  // Bars
  bars.forEach(({ label, value, fill, light }, i) => {
    const x  = ox + step * (i + 1) + barW * i
    const y  = yv(value)
    const bh = oy + ch - y

    // Shadow bar
    out.push(rect({ x: x + 3, y: y + 3, w: barW, h: bh, fill: '#00000018', rx: 4 }))
    // Main bar
    out.push(rect({ x, y, w: barW, h: bh, fill: light, rx: 4 }))
    out.push(rect({ x, y, w: barW, h: Math.min(bh, 6), fill, rx: 4 }))
    out.push(rect({ x, y: y + 6, w: barW, h: bh - 6, fill: light }))
    // Value label
    out.push(text(x + barW / 2, y - 8, `${value} ms`, { size: 13, weight: '700', fill, anchor: 'middle' }))
    // X label
    out.push(text(x + barW / 2, oy + ch + 20, label, { size: 13, weight: '600', fill: C.gray, anchor: 'middle' }))
  })

  // Axis line
  out.push(line(ox, oy + ch, ox + cw, oy + ch, { stroke: C.axisLine, width: 1.5 }))

  // Summary stats at bottom
  const sy = oy + ch + 50
  const stats = [
    { label: 'Total Requests', value: String(d.results.totalRequests) },
    { label: 'Throughput',     value: `${d.results.throughputRps} RPS` },
    { label: 'False Positives', value: `${d.results.falsePositives} (${d.results.fpr.toFixed(2)}%)` },
    { label: 'Errors',          value: `${d.results.errors}` },
  ]
  const sw = (W - 80) / stats.length
  stats.forEach(({ label, value }, i) => {
    const sx = 40 + i * sw + sw / 2
    out.push(rect({ x: 40 + i * sw, y: sy - 24, w: sw - 12, h: 46, fill: C.cardBg, stroke: C.border, rx: 8 }))
    out.push(text(sx, sy - 4, value,  { size: 15, weight: '700', fill: C.blue,     anchor: 'middle' }))
    out.push(text(sx, sy + 14, label, { size: 10, fill: C.subtitle, anchor: 'middle' }))
  })

  return svgWrap(H, out.join('\n'))
}

// ── Chart 2: Throughput Time Series ──────────────────────────────────────────
function chartThroughputTimeSeries(d: PerfResult): string {
  const H   = 360
  const ox  = 75, oy = 80, cw = W - ox - 50, ch = 200

  const ts  = d.results.timeSeries
  const rpsValues = ts.map(t => t.rps)
  const maxRps    = Math.max(...rpsValues, 1) * 1.3
  const avgRps    = d.results.throughputRps

  const xv = (i: number) => ox + (i / (ts.length - 1 || 1)) * cw
  const yv = (v: number) => oy + ch - (v / maxRps) * ch
  const steps = 4

  const out: string[] = [
    chartHeader(
      'Request Throughput Over Time',
      `${d.config.vus} VUs · ${d.config.durationS}s · avg ${avgRps} RPS`,
      d.passed
    ),
    yGrid(ox, oy, cw, ch, maxRps, steps, v => `${Math.round(v)}`),
  ]

  // Y-axis label
  out.push(text(ox - 50, oy + ch / 2, 'Requests / sec', {
    size: 11, fill: C.gray, anchor: 'middle',
    family: `${FONT}; writing-mode: vertical-rl; text-orientation: mixed`,
  }))

  if (ts.length > 1) {
    // Area fill
    const areaPoints: [number, number][] = [
      [xv(0), oy + ch],
      ...ts.map((t, i): [number, number] => [xv(i), yv(t.rps)]),
      [xv(ts.length - 1), oy + ch],
    ]
    const areaPath = `M ${areaPoints.map(([x, y]) => `${x},${y}`).join(' L ')}`
    out.push(`<path d="${areaPath}" fill="${C.blueLight}" opacity="0.5" />`)

    // Main line
    const linePoints: [number, number][] = ts.map((t, i) => [xv(i), yv(t.rps)])
    out.push(polyline(linePoints, { stroke: C.blue, width: 2.5 }))

    // Data point circles
    ts.forEach((t, i) => {
      const x = xv(i), y = yv(t.rps)
      out.push(`<circle cx="${x}" cy="${y}" r="3.5" fill="${C.blue}" stroke="${C.bg}" stroke-width="1.5" />`)
    })

    // P50 latency line (secondary axis hint)
    const p50Points: [number, number][] = ts.map((t, i) => [xv(i), yv(t.p50Ms / (maxRps / Math.max(...rpsValues, 1)))])
    // Skip p50 overlay — clutters the chart

    // Average line
    const ay = yv(avgRps)
    out.push(line(ox, ay, ox + cw, ay, { stroke: C.orange, width: 1.5, dash: '6,4' }))
    out.push(text(ox + cw + 4, ay + 4, `avg: ${avgRps}`, { size: 10, fill: C.orange }))
  }

  // Axis line
  out.push(line(ox, oy + ch, ox + cw, oy + ch, { stroke: C.axisLine, width: 1.5 }))

  // X-axis labels
  const labelEvery = Math.max(1, Math.floor(ts.length / 8))
  ts.forEach((t, i) => {
    if (i % labelEvery !== 0 && i !== ts.length - 1) return
    out.push(text(xv(i), oy + ch + 18, `${t.second}s`, { size: 10, fill: C.gray, anchor: 'middle' }))
  })
  out.push(text(ox + cw / 2, oy + ch + 36, 'Elapsed (seconds)', { size: 11, fill: C.gray, anchor: 'middle' }))

  return svgWrap(H, out.join('\n'))
}

// ── Chart 3: Confusion Matrix ─────────────────────────────────────────────────
function chartConfusionMatrix(d: AccuracyResult): string {
  const H = 380
  const { tn, fp, tp, fn } = d.results.confusionMatrix
  const totalBenign   = tn + fp || 1
  const totalMalicious = tp + fn || 1

  const ox = 210, oy = 90, cw = W - ox - 60, rowH = 52, rowGap = 18

  const rows = [
    { label: 'True Negatives',  sub: 'benign → 200 ✓', value: tn, total: totalBenign,    fill: C.green,  light: C.greenLight,  pct: (tn / totalBenign)   * 100 },
    { label: 'False Positives', sub: 'benign → 403 ✗', value: fp, total: totalBenign,    fill: C.red,    light: C.redLight,    pct: (fp / totalBenign)   * 100 },
    { label: 'True Positives',  sub: 'attack → 403 ✓', value: tp, total: totalMalicious, fill: C.green,  light: C.greenLight,  pct: (tp / totalMalicious) * 100 },
    { label: 'False Negatives', sub: 'attack → 200 ✗', value: fn, total: totalMalicious, fill: C.orange, light: C.orangeLight, pct: (fn / totalMalicious) * 100 },
  ]

  const totalRequests = tn + fp + tp + fn

  const out: string[] = [
    chartHeader(
      'Detection Results — Confusion Matrix',
      `${d.config.vus} VUs · ${totalRequests} total requests · ${(d.config.benignRatio * 100).toFixed(0)}% benign`,
      d.passed
    ),
  ]

  rows.forEach(({ label, sub, value, fill, light, pct }, i) => {
    const y     = oy + i * (rowH + rowGap)
    const barW  = value > 0 ? Math.max(4, (pct / 100) * cw) : 0

    out.push(rect({ x: ox, y, w: cw, h: rowH, fill: '#f9f9f9', stroke: C.border, rx: 6 }))
    if (barW > 0) {
      out.push(rect({ x: ox, y, w: barW, h: rowH, fill: light, rx: 6 }))
      // Darker left edge
      out.push(rect({ x: ox, y, w: Math.min(6, barW), h: rowH, fill, rx: 6 }))
      if (barW > 8) out.push(rect({ x: ox + 6, y, w: barW - 6, h: rowH, fill: light }))
    }
    // Count label (inside or after bar)
    const countX = barW > 50 ? ox + barW - 10 : ox + barW + 8
    const countAnchor = barW > 50 ? 'end' : 'start'
    out.push(text(countX, y + rowH / 2 + 5, value === 0 ? 'none' : String(value), {
      size: 18, weight: '700', fill: barW > 50 ? fill : C.gray, anchor: countAnchor
    }))
    // Row labels (left)
    out.push(text(ox - 8, y + 18, label, { size: 13, weight: '600', fill: C.title, anchor: 'end' }))
    out.push(text(ox - 8, y + 36, sub,   { size: 11, fill: C.gray, anchor: 'end' }))
    // Percentage (right)
    out.push(text(ox + cw + 8, y + rowH / 2 + 5, `${pct.toFixed(1)}%`, { size: 11, fill: C.gray }))
  })

  // Divider between benign and malicious groups
  const divY = oy + 2 * (rowH + rowGap) - rowGap / 2
  out.push(line(ox - 20, divY, ox + cw + 60, divY, { stroke: C.border, dash: '4,4' }))
  out.push(text(ox - 8, oy + rowH / 2 + 5 - 35, 'Benign', { size: 10, weight: '600', fill: C.subtitle, anchor: 'end' }))
  out.push(text(ox - 8, oy + 2 * (rowH + rowGap) + rowH / 2 + 5 - 35, 'Attack', { size: 10, weight: '600', fill: C.subtitle, anchor: 'end' }))

  // FPR/TPR summary line
  const sy = oy + 4 * (rowH + rowGap) + 10
  out.push(text(W / 2, sy + 4,  `FPR: ${d.results.fpr.toFixed(2)}%  ·  TPR: ${d.results.tpr.toFixed(2)}%  ·  ${totalRequests} total requests`, {
    size: 12, fill: C.subtitle, anchor: 'middle'
  }))

  return svgWrap(H, out.join('\n'))
}

// ── Chart 4: Accuracy Rates ───────────────────────────────────────────────────
function chartAccuracyRates(d: AccuracyResult): string {
  const H   = 400
  const ox  = 50, cw = W - ox - 60, barH = 40, pad = 20

  // ── FPR gauge ──
  // FPR: lower is better. Bar fills from 0% to fpr. Ceiling marked with vertical line.
  const fprCeiling = d.config.fprMax
  const fprActual  = Math.min(d.results.fpr, 100)
  const fprScale   = 5   // show 0–5% range for FPR (ceiling is usually 2%)
  const fprBarW    = (fprActual / fprScale) * cw
  const fprCeilX   = ox + (fprCeiling / fprScale) * cw
  const fprGood    = fprActual <= fprCeiling

  // ── TPR gauge ──
  // TPR: higher is better. Bar fills from 0% to tpr. Floor marked.
  const tprFloor  = d.config.tprMin
  const tprActual = Math.min(d.results.tpr, 100)
  const tprBarW   = (tprActual / 100) * cw
  const tprFloorX = ox + (tprFloor / 100) * cw
  const tprGood   = tprActual >= tprFloor

  const sections = [
    // FPR section
    {
      label: 'False Positive Rate', sub: `ceiling: ${fprCeiling}%`, oy: 100,
      actual: fprActual, actualLabel: `${d.results.fpr.toFixed(2)}%`,
      barW: Math.max(0, fprBarW), fill: fprGood ? C.green : C.red, light: fprGood ? C.greenLight : C.redLight,
      threshX: fprCeilX, threshLabel: `${fprCeiling}%`, good: fprGood,
      note: fprGood ? `✓ ${d.results.confusionMatrix.fp} benign blocked` : `✗ ${d.results.confusionMatrix.fp} benign blocked`,
      noteColor: fprGood ? C.pass : C.fail,
      xAxisMax: `${fprScale}%`,
    },
    // TPR section
    {
      label: 'True Positive Rate', sub: `floor: ${tprFloor}%`, oy: 240,
      actual: tprActual, actualLabel: `${d.results.tpr.toFixed(2)}%`,
      barW: tprBarW, fill: tprGood ? C.green : C.red, light: tprGood ? C.greenLight : C.redLight,
      threshX: tprFloorX, threshLabel: `${tprFloor}%`, good: tprGood,
      note: tprGood ? `✓ ${d.results.confusionMatrix.tp}/${d.results.confusionMatrix.tp + d.results.confusionMatrix.fn} attacks blocked` : `✗ ${d.results.confusionMatrix.fn} attacks missed`,
      noteColor: tprGood ? C.pass : C.fail,
      xAxisMax: '100%',
    },
  ]

  const out: string[] = [
    chartHeader(
      'Accuracy Rates vs Thresholds',
      `${d.config.vus} VUs · ${d.config.iterations} iterations/VU · ${(d.config.benignRatio * 100).toFixed(0)}% benign mix`,
      d.passed
    ),
  ]

  sections.forEach(({ label, sub, oy: soy, actualLabel, barW: bw, fill, light, threshX, threshLabel, good, note, noteColor, xAxisMax }) => {
    // Section label
    out.push(text(ox, soy - 14, label, { size: 14, weight: '700', fill: C.title }))
    out.push(text(ox, soy - 0, sub,   { size: 11, fill: C.subtitle }))

    // Track background
    out.push(rect({ x: ox, y: soy + pad, w: cw, h: barH, fill: '#f0f0f0', rx: 8 }))

    // Filled bar
    if (bw > 0) {
      out.push(rect({ x: ox, y: soy + pad, w: Math.min(bw, cw), h: barH, fill: light, rx: 8 }))
      out.push(rect({ x: ox, y: soy + pad, w: Math.min(bw, cw), h: barH / 3, fill, rx: 8 }))
      out.push(rect({ x: ox, y: soy + pad + barH / 3, w: Math.min(bw, cw), h: barH * 2 / 3, fill: light }))
    }

    // Actual value label (inside or outside bar)
    const valX = bw > 100 ? ox + Math.min(bw, cw) - 8 : ox + Math.min(bw, cw) + 10
    const valAnchor = bw > 100 ? 'end' : 'start'
    out.push(text(valX, soy + pad + barH / 2 + 5, actualLabel, { size: 16, weight: '700', fill, anchor: valAnchor }))

    // Threshold vertical line
    if (threshX >= ox && threshX <= ox + cw) {
      out.push(line(threshX, soy + pad - 8, threshX, soy + pad + barH + 8, { stroke: C.gray, width: 2, dash: '4,3' }))
      out.push(text(threshX, soy + pad - 12, threshLabel, { size: 10, fill: C.gray, anchor: 'middle' }))
    }

    // X-axis: 0 and max
    out.push(text(ox,        soy + pad + barH + 18, '0%',     { size: 10, fill: C.gray }))
    out.push(text(ox + cw,   soy + pad + barH + 18, xAxisMax, { size: 10, fill: C.gray, anchor: 'end' }))
    out.push(line(ox, soy + pad + barH, ox + cw, soy + pad + barH, { stroke: C.axisLine }))

    // Note
    out.push(text(ox + cw + 10, soy + pad + barH / 2 + 5, note, { size: 11, fill: noteColor }))

    // Pass/fail badge
    const bx = ox + cw - 70, by = soy - 22
    out.push(rect({ x: bx, y: by, w: 72, h: 22, fill: good ? C.greenLight : C.redLight, rx: 11 }))
    out.push(text(bx + 36, by + 15, good ? '✓ OK' : '✗ FAIL', { size: 11, weight: '700', fill: good ? C.pass : C.fail, anchor: 'middle' }))
  })

  // Latency summary
  const latY = 345
  out.push(line(40, latY, W - 40, latY, { stroke: C.border }))
  const latStats = [
    { label: 'p50',    value: `${d.results.p50LatencyMs} ms` },
    { label: 'p95',    value: `${d.results.p95LatencyMs} ms` },
    { label: 'p99',    value: `${d.results.p99LatencyMs} ms` },
    { label: 'avg',    value: `${d.results.avgLatencyMs.toFixed(1)} ms` },
  ]
  const sw = (W - 80) / latStats.length
  latStats.forEach(({ label, value }, i) => {
    const sx = 40 + i * sw + sw / 2
    out.push(text(sx, latY + 22, value, { size: 14, weight: '700', fill: C.blue,     anchor: 'middle' }))
    out.push(text(sx, latY + 38, label, { size: 10, fill: C.subtitle, anchor: 'middle' }))
  })

  return svgWrap(H, out.join('\n'))
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  const [, , perfFile, accFile] = process.argv

  if (!perfFile || !accFile) {
    console.error('Usage: gen-load-charts.ts <performance.json> <accuracy.json>')
    process.exit(1)
  }

  const perf: PerfResult      = JSON.parse(readFileSync(perfFile, 'utf8'))
  const acc:  AccuracyResult  = JSON.parse(readFileSync(accFile,  'utf8'))

  const perfDir  = dirname(perfFile)
  const accDir   = dirname(accFile)
  const perfBase = basename(perfFile, '.json')
  const accBase  = basename(accFile,  '.json')

  const charts: [string, string][] = [
    [join(perfDir, perfBase.replace('performance', 'chart-latency-distribution') + '.svg'), chartLatencyDistribution(perf)],
    [join(perfDir, perfBase.replace('performance', 'chart-throughput-timeseries') + '.svg'), chartThroughputTimeSeries(perf)],
    [join(accDir,  accBase.replace('accuracy',    'chart-confusion-matrix')      + '.svg'), chartConfusionMatrix(acc)],
    [join(accDir,  accBase.replace('accuracy',    'chart-accuracy-rates')        + '.svg'), chartAccuracyRates(acc)],
  ]

  for (const [path, svg] of charts) {
    writeFileSync(path, svg, 'utf8')
    console.log(`  ✓ ${path}`)
  }
}

main()
