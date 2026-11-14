/**
 * Compare load benchmark runs across versions (npm run bench:load:compare).
 *
 *   npm run bench:load:compare -- <results.json>... [--out DIR] [--label <commit>=<name>]...
 *
 * Runs of the same commit are grouped and reported as the median with the
 * min-max range; the first commit given is the baseline. Writes
 * comparison.json (for scripts/load-bench-compare-charts.py) and
 * comparison.md, and prints the Markdown. See test/load/lib/benchCompare.ts.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareRuns, comparisonMarkdown, type BenchResult } from './lib/benchCompare.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

function main(): void {
  const args = process.argv.slice(2)
  const files: string[] = []
  const labels: Record<string, string> = {}
  let out: string | undefined
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--out') out = args[++i]
    else if (a === '--label') {
      const [commit, ...name] = (args[++i] ?? '').split('=')
      if (!commit || name.length === 0) throw new Error('--label takes <commit>=<name>')
      labels[commit] = name.join('=')
    } else if (a.startsWith('--')) throw new Error(`unknown option ${a}`)
    else files.push(a)
  }
  if (files.length === 0) {
    console.error('usage: npm run bench:load:compare -- <results.json>... [--out DIR] [--label <commit>=<name>]...')
    process.exit(2)
  }
  const runs = files.map(f => JSON.parse(readFileSync(f, 'utf8')) as BenchResult)
  const comparison = compareRuns(runs, { labels })
  const stamp = new Date().toISOString().slice(0, 16).replace('T', '_').replace(':', '-')
  const dir = resolve(out ?? join(ROOT, 'reports', 'load-bench', `compare-${stamp}`))
  mkdirSync(dir, { recursive: true })
  const md = comparisonMarkdown(comparison)
  writeFileSync(join(dir, 'comparison.json'), JSON.stringify(comparison, null, 2))
  writeFileSync(join(dir, 'comparison.md'), md)
  console.log(md)
  console.log(`Written to ${dir}`)
  console.log(`Charts: python scripts/load-bench-compare-charts.py "${join(dir, 'comparison.json')}"`)
}

main()
