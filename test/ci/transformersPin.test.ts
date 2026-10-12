import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// @huggingface/transformers 4.3.0 moved onnxruntime-node from 1.24.3 to 1.30.0
// and with it 10 of 23,938 eval verdicts: two held-out attacks lost and the
// first oasst1 false positive (#278). The cosine thresholds are calibrated on
// 4.2.x vectors, so a minor or major arrives only with the recalibration
// tracked in #312, never as a routine Dependabot bump. Patches still flow.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
// CRLF folded so the line-anchored patterns hold on a Windows checkout (#283).
const DEPENDABOT = readFileSync(`${ROOT}.github/dependabot.yml`, 'utf8').replace(/\r\n/g, '\n')
const PKG = JSON.parse(readFileSync(`${ROOT}package.json`, 'utf8')) as { dependencies: Record<string, string> }

const npmBlock = (): string => {
  const start = DEPENDABOT.indexOf('- package-ecosystem: npm')
  const next = DEPENDABOT.indexOf('- package-ecosystem:', start + 1)
  return DEPENDABOT.slice(start, next === -1 ? undefined : next)
}

describe('@huggingface/transformers stays on the calibrated minor (#278, #312)', () => {
  // A caret range let an npm install of llm-fw, which gets no lockfile from
  // us, resolve 4.3.0 and run every scan on the uncalibrated runtime.
  it('is declared as a tilde range on the 4.2 line', () => {
    expect(PKG.dependencies['@huggingface/transformers']).toMatch(/^~4\.2\.\d+$/)
  })

  it('has Dependabot ignore its minor and major updates', () => {
    const block = npmBlock()
    const ignore = block.slice(block.indexOf('ignore:'))

    expect(block).toContain('ignore:')
    expect(ignore).toMatch(/- dependency-name: '?@huggingface\/transformers'?\n\s+update-types:\n\s+- version-update:semver-minor\n\s+- version-update:semver-major/)
  })
})
