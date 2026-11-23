import { watch, mkdirSync, FSWatcher } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { Config } from '../types.js'
import { getLlmFwDir } from './paths.js'
import { applyObserveMode, loadConfig } from './config.js'

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
// them so a config path can never pollute the prototype. Values are written
// only along the static HOT_PATHS allowlist; the paths read for the
// restart-required report come from the config's own keys, which is why
// changedLeaves and getPath skip these.
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** The paths where `a` and `b` differ, a list or a value counting as one leaf. */
function changedLeaves(a: unknown, b: unknown, path: Path = [], out: Path[] = []): Path[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (UNSAFE_KEYS.has(key)) continue
      changedLeaves(a[key], b[key], [...path, key], out)
    }
  } else if (differs(a, b)) {
    out.push(path)
  }
  return out
}

/** Whether `path` is applied live: under a hot path, or a section holding one. */
function coveredByHot(path: Path): boolean {
  return HOT_PATHS.some(hot => {
    const n = Math.min(hot.length, path.length)
    for (let i = 0; i < n; i++) if (hot[i] !== path[i]) return false
    return true
  })
}

function getPath(obj: unknown, path: Path): unknown {
  let cur: unknown = obj
  for (const key of path) {
    if (cur === null || typeof cur !== 'object' || UNSAFE_KEYS.has(key)) return undefined
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- read-only traversal; __proto__/constructor/prototype are rejected above.
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
    // A path element cannot be undefined for i < path.length. Refusing anyway
    // keeps the posture of the line below: when we do not know which key to
    // walk, we do not walk one.
    if (key === undefined || UNSAFE_KEYS.has(key)) return
    const next = cur[key]
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- keys are the static HOT_PATHS allowlist and __proto__/constructor/prototype are rejected above; creates missing intermediate config objects only.
    if (next === null || typeof next !== 'object') cur[key] = {}
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop -- see above: static allowlist keys, prototype keys rejected; read-only traversal step.
    cur = cur[key] as Record<string, unknown>
  }
  const last = path[path.length - 1]
  if (last === undefined || UNSAFE_KEYS.has(last)) return
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
  // Read per request: off stops taking pooled connections at once, and the
  // idle ones close on their own timer.
  ['proxy', 'upstreamKeepAlive'],
  ['detection', 'heuristicBlockThreshold'],
  ['detection', 'embeddingBlockThreshold'],
  ['detection', 'embeddingWarnThreshold'],
  ['detection', 'combinedBlockScore'],
  ['detection', 'embeddingMarginThreshold'],
  ['detection', 'chunkTokenLimit'],
  ['detection', 'chunkSize'],
  ['detection', 'chunkOverlap'],
  ['detection', 'embeddingMaxPassesPerRequest'],
  ['detection', 'judgeEnabled'],
  ['detection', 'judgeModel'],
  ['detection', 'judgeBlock'],
  ['detection', 'ollamaUrl'],
  ['detection', 'judgeUnlessBenign'],
  ['detection', 'scanSystemPrompt'],
  ['detection', 'intentMention'],
  ['detection', 'suppressions'],
  ['detection', 'failMode'],
  ['detection', 'classifier', 'enabled'],
  ['detection', 'classifier', 'blockThreshold'],
  ['detection', 'classifier', 'escalateThreshold'],
  ['detection', 'classifier', 'requireCorroboration'],
  ['detection', 'classifier', 'surfaces'],
  ['detection', 'surfaces', 'tool_result', 'heuristicBlockThreshold'],
  ['detection', 'surfaces', 'tool_result', 'embeddingMarginThreshold'],
  ['detection', 'surfaces', 'tool_result', 'classifierBlockThreshold'],
  ['detection', 'surfaces', 'tool_result', 'trustedPaths'],
  ['detection', 'surfaces', 'tool_result', 'onBlock'],
  ['detection', 'surfaces', 'document', 'heuristicBlockThreshold'],
  ['detection', 'surfaces', 'document', 'embeddingMarginThreshold'],
  ['detection', 'surfaces', 'document', 'classifierBlockThreshold'],
  ['detection', 'surfaces', 'prompt', 'wordingAction'],
  ['detection', 'surfaces', 'prompt', 'olderTurns'],
  ['detection', 'surfaces', 'prompt', 'highConfidenceHeuristic'],
  ['detection', 'surfaces', 'prompt', 'highConfidenceSimilarity'],
  ['detection', 'surfaces', 'prompt', 'highConfidenceMargin'],
  ['dlp', 'enabled'],
  ['dlp', 'mode'],
  // Read on every request; the dashboard already toggles them live (#864).
  ['asciiSmuggling', 'enabled'],
  ['memoryPoisoning', 'enabled'],
  ['memoryPoisoning', 'mode'],
  ['taint', 'enabled'],
  ['taint', 'mode'],
  ['proxy', 'urlFilter', 'enabled'],
  ['dos', 'maxRequestsPerMinute'],
  ['dos', 'maxTokensPerSession'],
  ['responseScan', 'classifier', 'blockThreshold'],
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
  ['nonText', 'transcribe'],
  ['manyShot', 'enabled'],
  ['manyShot', 'mode'],
  ['crescendo', 'enabled'],
  ['crescendo', 'mode'],
  ['crescendo', 'crossRequest'],
  ['crescendo', 'probeEscalation'],
  ['indirectInstruction', 'enabled'],
  ['indirectInstruction', 'mode'],
  ['indirectInstruction', 'trustedRecipientDomains'],
  ['indirectInstruction', 'untargetedImperative'],
  ['harmfulRequest', 'enabled'],
  ['harmfulRequest', 'mode'],
  ['responseScan', 'enabled'],
  ['responseScan', 'mode'],
  ['responseScan', 'harmfulCompliance'],
  ['responseScan', 'classifier', 'enabled'],
  ['responseScan', 'toolUse', 'enabled'],
  ['responseScan', 'toolUse', 'mode'],
  ['responseScan', 'canary', 'enabled'],
  ['responseScan', 'canary', 'mode'],
  ['blockStatus'],
  ['modules', 'enabled'],
  ['modules', 'tokenPruner', 'enabled'],
  ['modules', 'historyWindow', 'enabled'],
  ['modules', 'historyWindow', 'maxMessages'],
  ['modules', 'historyWindow', 'step'],
  ['modules', 'ansiStrip', 'enabled'],
  ['modules', 'progressCollapse', 'enabled'],
  ['modules', 'repeatCollapse', 'enabled'],
  ['modules', 'repeatCollapse', 'minRun'],
  ['modules', 'blobElide', 'enabled'],
  ['modules', 'blobElide', 'minLength'],
  ['modules', 'leanCtx', 'enabled'],
  ['modules', 'leanCtx', 'tools'],
  ['modules', 'leanCtx', 'skipCommands'],
  ['modules', 'leanCtx', 'timeoutMs'],
  ['modules', 'toolResultPruner', 'enabled'],
  ['modules', 'toolResultPruner', 'minifyJson'],
  ['modules', 'toolResultPruner', 'trimTrailing'],
  ['modules', 'toolResultPruner', 'collapseSpaceRuns'],
  ['modules', 'toolResultPruner', 'collapseStackFrames'],
  ['modules', 'toolResultDedup', 'enabled'],
  ['modules', 'toolResultDedup', 'minLength'],
  ['modules', 'toolResultTruncate', 'enabled'],
  ['modules', 'toolResultTruncate', 'headLines'],
  ['modules', 'toolResultTruncate', 'tailLines'],
  ['modules', 'toolResultTruncate', 'maxChars'],
  ['modules', 'toolResultTruncate', 'skipTools'],
  ['modules', 'toolResultTruncate', 'skipCommands'],
  ['modules', 'codeSkeleton', 'enabled'],
  ['modules', 'codeSkeleton', 'tools'],
  ['modules', 'codeSkeleton', 'minLines'],
  ['modules', 'codeSkeleton', 'minBodyLines'],
  ['modules', 'toolFilter', 'enabled'],
  ['modules', 'toolFilter', 'dropTools'],
  ['modules', 'toolFilter', 'shortenTools'],
  ['modules', 'toolFilter', 'shortenTo'],
  ['modules', 'toolFilter', 'dropSkills'],
  ['modules', 'toolDefinitionPruner', 'enabled'],
  ['modules', 'toolUsage', 'enabled'],
  ['modules', 'streamUsage', 'enabled'],
  ['modules', 'cacheControl', 'enabled'],
  ['modules', 'cacheControl', 'ttl'],
  ['modules', 'cacheControl', 'cacheSystem'],
  ['modules', 'cacheControl', 'shortTtlClients'],
  ['modules', 'cacheControl', 'shortTtlScope'],
  ['modules', 'responseCache', 'enabled'],
  ['modules', 'responseCache', 'ttlSeconds'],
  ['modules', 'responseCache', 'maxEntries'],
  ['modules', 'responseCache', 'maxEntryBytes'],
  ['modules', 'usageMeter', 'enabled'],
  ['modules', 'promptMonitor', 'enabled'],
  ['modules', 'promptMonitor', 'maxEntries'],
  ['modules', 'promptMonitor', 'maxChars'],
]

// Restart-required keys. Every changed key that is not in HOT_PATHS is
// reported as needing a restart and left as it was (#864): a static list of
// cold keys drifted from the config, and a key in neither list was dropped
// without a word, so an edit to it looked applied and was not. Changing a
// cold key while running would desync a listening socket (ports, binds),
// leave stale hosts-file or portproxy state (targets, interceptDomains: the
// sinkhole is set up once, at boot), or change something built once at start
// (the model session, the inference worker, the audit log, the gateway's
// tenants and tokens, `enforcement`, whose observe relaxation cannot be
// undone in place).

/**
 * Diff `incoming` (a freshly loaded config) against `live` (the config object
 * the running pipeline/proxy/dashboard hold references into) and apply only
 * the hot-safe keys, in place. Cold-key changes are reported via `log` and
 * left untouched. Exported standalone (no fs/timers) so the diff/apply logic
 * is unit-testable without touching disk.
 */
//
// `previous` is the config the last load produced. When given, a key is
// applied only if the load result itself changed since then. Live config is
// not a load result: the dashboard changes it at runtime, `--observe` relaxes
// it in memory, and LLM_FW_* variables are re-applied by every loadConfig().
// Diffing against live alone reverted a dashboard toggle on any env-pinned key
// and re-armed enforcement under --observe whenever config.json was written.
export function applyHotReload(
  live: Config,
  incoming: Config,
  log: Logger = (msg) => console.warn(msg),
  previous?: Config,
): { applied: string[]; restartRequired: string[] } {
  const changedSinceLastLoad = (path: Path, next: unknown): boolean =>
    previous === undefined || differs(getPath(previous, path), next)

  const touched: { path: Path; was: unknown }[] = []
  for (const path of HOT_PATHS) {
    const next = getPath(incoming, path)
    const cur = getPath(live, path)
    if (changedSinceLastLoad(path, next) && differs(cur, next)) {
      setPath(live, path, next)
      touched.push({ path, was: cur })
    }
  }
  // Observation never enforces: a mode edited on disk while observing is
  // relaxed again, exactly as `start --observe` relaxed it at boot. Then only
  // what actually ended up different is reported as applied.
  if (touched.length && live.enforcement === 'observe') applyObserveMode(live)
  const applied = touched.filter(t => differs(t.was, getPath(live, t.path))).map(t => pathStr(t.path))

  const restartRequired: string[] = []
  for (const path of changedLeaves(live, incoming)) {
    if (coveredByHot(path)) continue
    if (changedSinceLastLoad(path, getPath(incoming, path))) restartRequired.push(pathStr(path))
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
  const watchers: FSWatcher[] = []
  let stopped = false
  // One reload at a time (#864): an edit landing while a reload still reads
  // used to start a second beside it, and the two applied in either order.
  // One that arrives meanwhile is read once the running one ends.
  let running = false
  let again = false
  // The baseline each reload is diffed against (see applyHotReload): live
  // config as it stands when watching starts, which is loadConfig()'s result
  // plus any CLI flags. Taken synchronously, so an edit that lands right after
  // start is never folded into the baseline and missed. A flag-relaxed mode
  // (--observe) that differs from the file is re-relaxed after any apply.
  let previous: Config = structuredClone(live)

  const runReload = (): void => {
    timer = null
    if (running) { again = true; return }
    running = true
    reload()
      .then((incoming) => {
        if (stopped) return
        applyHotReload(live, incoming, log, previous)
        previous = incoming
      })
      .catch((err: unknown) => {
        // Transient read/parse failures mid atomic-save are expected — never
        // let a hot-reload hiccup take down the running proxy.
        log(`llm-fw: config hot-reload failed: ${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        running = false
        if (again && !stopped) { again = false; runReload() }
      })
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(runReload, debounceMs)
  }

  // The files a reload reads, by the directory each is in: config.json, and
  // the file LLM_FW_CONFIG names (a mounted Kubernetes ConfigMap, #864).
  const watched = new Map<string, Set<string>>([[dir, new Set([CONFIG_FILENAME])]])
  const project = process.env.LLM_FW_CONFIG
  if (project) {
    const projectDir = dirname(resolve(project))
    watched.set(projectDir, new Set([...(watched.get(projectDir) ?? []), basename(project)]))
  }
  // A data directory that does not exist yet is created, not given up on
  // (#864): watching it failed once and the watcher never came back.
  try { mkdirSync(dir, { recursive: true }) } catch { /* reported by watch below */ }
  for (const [where, names] of watched) {
    try {
      const w = watch(where, (_eventType, filename) => {
        // `filename` is null on some platforms/filesystems for directory
        // watches — treat that as "might be ours" and reload anyway rather
        // than risk silently missing the change.
        if (filename !== null && !names.has(filename)) return
        schedule()
      })
      w.on('error', (err) => {
        log(`llm-fw: config hot-reload watcher error: ${err.message}`)
      })
      watchers.push(w)
    } catch (err) {
      log(`llm-fw: config hot-reload disabled for ${where} — could not watch it: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  return {
    stop(): void {
      stopped = true
      if (timer) clearTimeout(timer)
      for (const w of watchers.splice(0)) w.close()
    },
  }
}
