// Row-by-row comparison of two transcript replays (scripts/replay-transcripts.ts).
// Aggregates can hold while items trade places, so a ruleset change quotes
// which items moved, not only the new total.

export interface ReplayRecord {
  key: string
  client: string
  kind: string
  action: 'pass' | 'warn' | 'block'
  stage?: string
  file: string
  /** Set on blocked items only. */
  preview?: string
  text?: string
}

export interface ReplayDiff {
  compared: number
  changed: { before: ReplayRecord; after: ReplayRecord }[]
  newlyBlocked: ReplayRecord[]
  /** The record from the BEFORE run, so its stage and preview say what used to block. */
  unblocked: ReplayRecord[]
}

/** Compare items present in both runs, matched by key. */
export function diffReplays(before: readonly ReplayRecord[], after: readonly ReplayRecord[]): ReplayDiff {
  const prior = new Map(before.map(r => [r.key, r]))
  const d: ReplayDiff = { compared: 0, changed: [], newlyBlocked: [], unblocked: [] }
  for (const a of after) {
    const b = prior.get(a.key)
    if (!b) continue
    d.compared++
    if (b.action === a.action && b.stage === a.stage) continue
    d.changed.push({ before: b, after: a })
    if (a.action === 'block' && b.action !== 'block') d.newlyBlocked.push(a)
    if (b.action === 'block' && a.action !== 'block') d.unblocked.push(b)
  }
  return d
}
