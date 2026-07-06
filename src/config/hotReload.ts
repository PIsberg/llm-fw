import { watch, FSWatcher } from 'node:fs'
import { Config } from '../types.js'
import { getLlmFwDir } from './paths.js'
import { loadConfig } from './config.js'

const DEFAULT_DEBOUNCE_MS = 500
const CONFIG_FILENAME = 'config.json'

type Logger = (message: string) => void
type Path = readonly string[]

export interface HotReloadHandle {
  stop(): void
}

export interface HotReloadOptions {
  /** Debounce window (ms) collapsing the burst of fs events a single atomic
   *  save produces. Default 500 (production). Tests inject a smaller value. */
  debounceMs?: number
  /** Sink for "applied"/"restart required" notices. Defaults to console.warn. */
  log?: Logger
  /** Replaces the disk re-read (loadConfig()) with a caller-supplied producer.
   *  Only used by tests that want to bypass the filesystem entirely. */
  reload?: () => Promise<Config>
}

// Keys that resolve to Object.prototype — refuse to traverse or write through
// them so a config path can never pollute the prototype. HOT_PATHS/COLD_PATHS
// are static allowlists (never attacker-derived), so this is belt-and-braces,
// but it keeps the walker safe if a dynamic path is ever passed in.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function getPath(obj: unknown, path: Path): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || UNSAFE_KEYS.has(key)) return undefined
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- keys are the static HOT_PATHS/COLD_PATHS allowlist and __proto__/constructor/prototype are rejected above; read-only traversal.
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

// Mutates `obj` IN PLACE along `path`, creating missing intermediate objects
// but never replacing one that already exists. This is load-bearing: several
// detection/proxy modules (EmbeddingChecker, InjectionClassifier, JudgeClient,
// DlpScanner, QuotaManager, McpScanner, OutputModerationClassifier) are
// constructed with a REFERENCE to a config sub-object (e.g. `config.detection`,
// `config.dlp`) and read fields off that same reference on every call — they
// never re-fetch it from the outer Config. Replacing `live.detection = {...}`
// wholesale would orphan every one of those references; writing leaf values
// onto the object they already hold keeps everyone in sync with zero wiring.
function setPath(obj: object, path: Path, value: unknown): void {
  let cur = obj as Record<string, unknown>
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i]
    if (UNSAFE_KEYS.has(key)) return
    const next = cur[key]
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- keys are the static HOT_PATHS allowlist and __proto__/constructor/prototype are rejected above; creates missing intermediate config objects only.
    if (next === null || typeof next !== 'object') cur[key] = {}
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- see above: static allowlist keys, prototype keys rejected; read-only traversal step.
    cur = cur[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (UNSAFE_KEYS.has(last)) return
  cur[last] = value
}

function pathStr(path: Path): string {
  return path.join('.')
}

// Cheap structural diff good enough for the primitive/array leaves below —
// exact key order in the JSON doesn't matter for the boolean/number/string
// settings this module cares about.
function differs(a: unknown, b: unknown): boolean {
  if (a === b) return false
  return JSON.stringify(a) !== JSON.stringify(b)
}

// HOT-SAFE keys (Task C5). detection.* is hot in full — every field, toggle
// AND threshold alike — because the pipeline/embedding/classifier/judge stages
// all resolve `config.detection.*` fresh on every scan (verified in
// pipeline.ts's per-run() destructuring and embedding.ts/classifier.ts/
// judge.ts's live getters), never a value captured once at construction. The
// other stage configs are restricted to their enabled/mode-style toggles —
// per the plan, thresholds under those sections (e.g. dos rate limits,
// manyShot turn counts) are left for a restart.
const HOT_PATHS: Path[] = [
  ['detection', 'heuristicBlockThreshold'],
  ['detection', 'embeddingBlockThreshold'],
  ['detection', 'embeddingWarnThreshold'],
  ['detection', 'embeddingMarginThreshold'],
  ['detection', 'chunkTokenLimit'],
  ['detection', 'chunkSize'],
  ['detection', 'chunkOverlap'],
  ['detection', 'judgeEnabled'],
  ['detection', 'judgeModel'],
  ['detection', 'judgeBlock'],
  ['detection', 'ollamaUrl'],
  ['detection', 'judgeUnlessBenign'],
  ['detection', 'scanSystemPrompt'],
  ['detection', 'intentMention'],
  ['detection', 'suppressions'],
  ['detection', 'failMode'],
  ['detection', 'workerInference'],
  ['detection', 'classifier', 'enabled'],
  ['detection', 'classifier', 'blockThreshold'],
  ['detection', 'classifier', 'escalateThreshold'],
  ['detection', 'surfaces', 'tool_result', 'heuristicBlockThreshold'],
  ['detection', 'surfaces', 'tool_result', 'embeddingMarginThreshold'],
  ['detection', 'surfaces', 'document', 'heuristicBlockThreshold'],
  ['detection', 'surfaces', 'document', 'embeddingMarginThreshold'],
  ['dlp', 'enabled'],
  ['dlp', 'mode'],
  ['dos', 'enabled'],
  ['dos', 'loopDetectionEnabled'],
  ['rag', 'enabled'],
  ['mcp', 'enabled'],
  ['mcp', 'auditOnly'],
  ['mcp', 'guardrailsEnabled'],
  ['mcp', 'guardrailsCategories', 'a'],
  ['mcp', 'guardrailsCategories', 'b'],
  ['mcp', 'guardrailsCategories', 'c'],
  ['mcp', 'guardrailsCategories', 'd'],
  ['nonText', 'enabled'],
  ['nonText', 'mode'],
  ['nonText', 'ocr'],
  ['manyShot', 'enabled'],
  ['manyShot', 'mode'],
  ['crescendo', 'enabled'],
  ['crescendo', 'mode'],
  ['crescendo', 'crossRequest'],
  ['indirectInstruction', 'enabled'],
  ['indirectInstruction', 'mode'],
  ['harmfulRequest', 'enabled'],
  ['harmfulRequest', 'mode'],
  ['responseScan', 'enabled'],
  ['responseScan', 'mode'],
  ['responseScan', 'harmfulCompliance'],
  ['responseScan', 'classifier', 'enabled'],
  ['responseScan', 'toolUse', 'enabled'],
  ['responseScan', 'toolUse', 'mode'],
]

// COLD keys (Task C5) — changing any of these while the process is running
// would either desync a listening socket (proxy/dashboard ports+binds), leave
// stale hosts-file/portproxy state (targets/interceptDomains — see
// cli/start.ts's sinkhole setup, which only runs once at boot), or silently
// stop covering a provider host mid-flight. Detected and reported, never
// applied.
const COLD_PATHS: Path[] = [
  ['proxy', 'port'],
  ['proxy', 'httpsPort'],
  ['proxy', 'mode'],
  ['proxy', 'bindHost'],
  ['proxy', 'bypass'],
  ['dashboard', 'port'],
  ['dashboard', 'bindHost'],
  ['targets'],
  ['extraTargets'],
  ['proxy', 'interceptDomains'],
]

/**
 * Diff `incoming` (a freshly loaded config) against `live` (the config object
 * the running pipeline/proxy/dashboard hold references into) and apply only
 * the hot-safe keys, in place. Cold-key changes are reported via `log` and
 * left untouched. Exported standalone (no fs/timers) so the diff/apply logic
 * is unit-testable without touching disk.
 */
export function applyHotReload(
  live: Config,
  incoming: Config,
  log: Logger = (msg) => console.warn(msg),
): { applied: string[]; restartRequired: string[] } {
  const applied: string[] = []
  for (const path of HOT_PATHS) {
    const next = getPath(incoming, path)
    const cur = getPath(live, path)
    if (differs(cur, next)) {
      setPath(live, path, next)
      applied.push(pathStr(path))
    }
  }

  const restartRequired: string[] = []
  for (const path of COLD_PATHS) {
    const next = getPath(incoming, path)
    const cur = getPath(live, path)
    if (differs(cur, next)) restartRequired.push(pathStr(path))
  }

  if (restartRequired.length) {
    log(`llm-fw: config.json changed keys that require a restart to take effect: ${restartRequired.join(', ')}`)
  }
  if (applied.length) {
    log(`llm-fw: hot-reloaded config keys: ${applied.join(', ')}`)
  }

  return { applied, restartRequired }
}

/**
 * Watch `<getLlmFwDir()>/config.json` for edits and hot-apply detection/dlp/
 * dos/rag/mcp/nonText/manyShot/crescendo/indirectInstruction/harmfulRequest/
 * responseScan toggles+thresholds onto the live `config` object — no restart.
 *
 * Watches the CONTAINING DIRECTORY (not the file) so an editor's atomic
 * "write a temp file then rename over the original" save is never missed: a
 * bare `fs.watch(file)` can silently stop firing once the original inode is
 * replaced by a rename (platform-dependent), whereas watching the directory
 * and filtering for the `config.json` dirent survives the swap because the
 * watched entity (the directory) never changes identity.
 *
 * `getLlmFwDir()` is called HERE (at watch-start time), not at module load, so
 * tests pointing LLM_FW_DIR at a temp directory are respected.
 */
export function startConfigHotReload(live: Config, options: HotReloadOptions = {}): HotReloadHandle {
  if (live.hotReload === false) return { stop() { /* never started */ } }

  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const log = options.log ?? ((msg: string) => console.warn(msg))
  const reload = options.reload ?? loadConfig
  const dir = getLlmFwDir()

  let timer: NodeJS.Timeout | null = null
  let watcher: FSWatcher | null = null
  let stopped = false

  const runReload = (): void => {
    timer = null
    reload()
      .then((incoming) => {
        if (stopped) return
        applyHotReload(live, incoming, log)
      })
      .catch((err: unknown) => {
        // Transient read/parse failures mid atomic-save are expected — never
        // let a hot-reload hiccup take down the running proxy.
        log(`llm-fw: config hot-reload failed: ${err instanceof Error ? err.message : String(err)}`)
      })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runReload, debounceMs)
  }

  try {
    watcher = watch(dir, (_eventType, filename) => {
      // `filename` is null on some platforms/filesystems for directory
      // watches — treat that as "might be config.json" and reload anyway
      // rather than risk silently missing the change.
      if (filename !== null && filename !== CONFIG_FILENAME) return
      schedule()
    })
    watcher.on('error', (err) => {
      log(`llm-fw: config hot-reload watcher error: ${err.message}`)
    })
  } catch (err) {
    log(`llm-fw: config hot-reload disabled — could not watch ${dir}: ${err instanceof Error ? err.message : String(err)}`)
  }

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      watcher?.close()
      watcher = null
    },
  }
}
