/**
 * Decision logic for the user-environment variables `setup` writes on Windows
 * (HKCU\Environment) and `uninstall` takes back. Pure functions, so the rules
 * are testable on every OS; the registry reads and writes live in setup.ts and
 * uninstall.ts.
 *
 * The rules, in one line each:
 * - setup records what a variable held before llm-fw overwrote it, so uninstall
 *   can put it back;
 * - uninstall touches a variable only while it still holds an llm-fw value, and
 *   restores the recorded value or deletes the variable when nothing was recorded.
 */

export const LLMFW_USER_ENV = ['HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'] as const
export type EnvName = (typeof LLMFW_USER_ENV)[number]

/** A value per name: a string when set, `null` when the variable is absent. */
export type EnvSnapshot = Partial<Record<EnvName, string | null>>

/** True when `value` is one llm-fw writes for `name`. Same discrimination as the POSIX profile strip. */
export function isLlmfwEnvValue(name: EnvName, value: string): boolean {
  switch (name) {
    case 'HTTPS_PROXY':
      return /(?:127\.0\.0\.1|localhost):\d+/.test(value)
    case 'NO_PROXY':
      return value.includes('127.0.0.1')
    case 'NODE_EXTRA_CA_CERTS':
      return /\.llm-fw[\\/]ca\.crt/.test(value)
  }
}

/**
 * Remember what each of `names` held before setup overwrites it. Entries already
 * recorded are kept, so a second run of setup cannot replace the user's value
 * with llm-fw's own. An llm-fw value is never recorded as the prior one.
 */
export function recordPriorEnv(current: EnvSnapshot, prior: EnvSnapshot, names: readonly EnvName[]): EnvSnapshot {
  const next: EnvSnapshot = { ...prior }
  for (const name of names) {
    if (name in next) continue
    const value = current[name]
    if (value === undefined) continue
    if (value !== null && isLlmfwEnvValue(name, value)) continue
    next[name] = value
  }
  return next
}

/**
 * What uninstall should do to each variable. `set` holds values to restore, and
 * `remove` holds variables to delete. A variable is touched only while it still
 * holds an llm-fw value: one the user has since edited, or one that is absent, is left alone.
 */
export function planEnvRestore(
  current: EnvSnapshot,
  prior: EnvSnapshot,
): { set: Partial<Record<EnvName, string>>; remove: EnvName[] } {
  const set: Partial<Record<EnvName, string>> = {}
  const remove: EnvName[] = []
  for (const name of LLMFW_USER_ENV) {
    const value = current[name]
    if (value === undefined || value === null) continue
    if (!isLlmfwEnvValue(name, value)) continue
    const original = prior[name]
    if (typeof original === 'string') set[name] = original
    else remove.push(name)
  }
  return { set, remove }
}

/**
 * Read one value out of `reg query HKCU\Environment /v NAME` output. Returns
 * `null` when the variable is not in the output. The value keeps any spaces it contains.
 */
export function parseRegQueryValue(output: string, name: string): string | null {
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim()
    if (!text.startsWith(name)) continue
    // The name must be followed by a REG_* type. Anything else is a longer name
    // that merely starts with this one (NO_PROXY versus NO_PROXY_EXTRA).
    const typed = /^\s+REG_\w+(?:\s+|$)/.exec(text.slice(name.length))
    if (typed) return text.slice(name.length + typed[0].length)
  }
  return null
}
