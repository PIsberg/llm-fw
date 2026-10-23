/**
 * Says when the Node.js this process runs on predates a security release that
 * reaches llm-fw's own code paths.
 *
 * The proxy brotli-decompresses every upstream response it inspects
 * (`decompressBody` in src/proxy/proxy.ts) and verifies upstream certificates
 * with `tls.checkServerIdentity`, so the October 2026 Node.js security release
 * (CVE-2026-111497, an out-of-bounds write in the Brotli decoder reachable from
 * malformed input; CVE-2026-105483 and CVE-2026-106069, certificate hostname
 * checks fooled by non-canonical IP literals) is reachable from a provider
 * response. `engines.node >=22` cannot express "22, but at least 22.23.4", and
 * npm only warns about engines anyway, so `llm-fw start` says it on the console
 * and `llm-fw doctor` repeats it as a check.
 *
 * The container image carries its own patched Node (the digest in the
 * Dockerfile); this is for the npm install, where the runtime is the user's.
 */

/** The first patch of each supported line that carries the October 2026 security release. */
export const PATCHED_NODE: Readonly<Record<number, string>> = Object.freeze({
  22: '22.23.4',
  24: '24.22.1',
  26: '26.12.1',
})

const RELEASE = 'the October 2026 Node.js security release (CVE-2026-111497, a Brotli decoder flaw reachable from a provider response)'

function parse(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function olderThan(a: [number, number, number], b: [number, number, number]): boolean {
  if (a[0] !== b[0]) return a[0] < b[0]
  if (a[1] !== b[1]) return a[1] < b[1]
  return a[2] < b[2]
}

/**
 * A one-line warning when `version` (default: this process) runs a Node.js
 * that lacks the October 2026 fixes, or null when it is patched, newer than
 * any line this table knows, or unparseable.
 */
export function nodeRuntimeAdvisory(version: string = process.version): string | null {
  const running = parse(version)
  if (!running) return null
  const [major] = running
  const newest = Math.max(...Object.keys(PATCHED_NODE).map(Number))
  if (major > newest) return null
  const patched = PATCHED_NODE[major]
  if (!patched) {
    return `Node.js v${running.join('.')} is an end-of-life line and never receives ${RELEASE}. Move to Node ${Object.values(PATCHED_NODE).join(', ')} or newer.`
  }
  if (!olderThan(running, parse(patched)!)) return null
  return `Node.js v${running.join('.')} predates ${RELEASE}. Upgrade to ${patched} or newer.`
}
