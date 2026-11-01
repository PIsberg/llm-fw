/**
 * The version line `llm-fw start` prints, and a check for a newer release on
 * npm (#597).
 *
 * The check runs after every listener is bound, never awaits on the startup
 * path, gives up after a short timeout and says nothing on any failure: a
 * firewall must start the same offline as online. It sends one GET to the
 * public npm registry and nothing else (no identifier, no telemetry). Switch it
 * off with `updateCheck: false` or `LLM_FW_UPDATE_CHECK=false`; it is skipped
 * under CI.
 */

const REGISTRY_URL = 'https://registry.npmjs.org/llm-fw/latest'

/** What a user runs to move to the newest release. */
export const UPDATE_COMMAND = 'npm install -g llm-fw@latest, then llm-fw stop && llm-fw start'

type Parsed = { core: [number, number, number]; pre: boolean }

function parse(version: string): Parsed | null {
  const m = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(-[0-9A-Za-z.-]{1,64})?$/.exec(version.trim())
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] !== undefined } : null
}

/** True when `latest` is a newer release than `current`; false when either is unparseable. */
export function isNewer(current: string, latest: string): boolean {
  const a = parse(current)
  const b = parse(latest)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return b.core[i]! > a.core[i]!
  // Same core: a release is newer than its prerelease.
  return a.pre && !b.pre
}

/**
 * The line to print when the registry has a newer release, or null when this
 * is the latest or the registry could not be read in `timeoutMs`.
 */
export async function checkForUpdate(current: string, fetchImpl: typeof fetch = fetch, timeoutMs = 2000): Promise<string | null> {
  try {
    const res = await fetchImpl(REGISTRY_URL, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } })
    if (!res.ok) return null
    const body = (await res.json()) as { version?: unknown }
    if (typeof body.version !== 'string' || !isNewer(current, body.version)) return null
    return `llm-fw ${body.version} is available (this is ${current}). Update with: ${UPDATE_COMMAND}`
  } catch {
    return null
  }
}

/** Whether `llm-fw start` should check: on unless switched off, and never under CI. */
export function shouldCheckForUpdates(config: { updateCheck?: boolean }, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.CI) return false
  return config.updateCheck !== false
}

/** The first line `llm-fw start` prints. */
export function startupBanner(version: string, ruleset: string): string {
  return `llm-fw ${version} (ruleset ${ruleset})`
}
