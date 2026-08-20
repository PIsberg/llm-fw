import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Structured logging for llm-fw.
 *
 * Deliberately ~100 lines and no dependency. This package ships three runtime
 * dependencies on purpose and CONTRIBUTING.md says a fourth is a decision, not
 * an assumption: every dependency of a security product is attack surface the
 * user inherits. pino is excellent and would earn its place in a service with
 * high-volume logging; here there are 28 log sites in the whole of src/ outside
 * the CLI, and levels plus JSON plus a correlation id is the entire ask.
 *
 * ## Why it writes through console
 *
 * Not `process.stderr.write`. Routing through console.warn/error/log keeps one
 * stdio discipline for the CLI, the library API and the tests, and it means a
 * library consumer can intercept llm-fw's output the same way they intercept
 * anything else. The existing suites that assert on console keep working: the
 * message text is inside the JSON they now receive.
 *
 * ## What must never be logged
 *
 * Prompt text, tool results, retrieved documents, credentials. This is a
 * firewall for traffic that contains exactly those things, and `audit` already
 * has `includePayloads` to gate payload capture deliberately. Log the shape of
 * an event, never its contents: a tool name yes, its arguments no.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50 };

/** Structured fields attached to one record. Never payloads. See the header. */
export type LogFields = Record<string, unknown>;

const store = new AsyncLocalStorage<{ requestId: string }>();

/**
 * Run `fn` with a correlation id attached to every log record it produces,
 * however deep. AsyncLocalStorage rather than passing an id down twenty call
 * sites: the detection pipeline does not otherwise need to know it is serving
 * a request.
 */
export function withRequestId<T>(requestId: string, fn: () => T): T {
  return store.run({ requestId }, fn);
}

/** The correlation id of the request being served, when there is one. */
export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

function configuredLevel(): LogLevel {
  const raw = (process.env['LLM_FW_LOG_LEVEL'] ?? '').toLowerCase();
  return raw in ORDER ? (raw as LogLevel) : 'info';
}

function jsonOutput(): boolean {
  const fmt = (process.env['LLM_FW_LOG_FORMAT'] ?? '').toLowerCase();
  if (fmt === 'json') return true;
  if (fmt === 'pretty') return false;
  // A terminal gets prose, a pipe gets JSON. The common case is right without
  // anyone configuring it: a human running `llm-fw start` and a container
  // shipping to a collector want opposite things.
  return !process.stderr.isTTY;
}

/** Errors do not survive JSON.stringify: it yields `{}`. Unpack them. */
function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Error) {
      out[k] = { message: v.message, name: v.name, ...(v.stack ? { stack: v.stack } : {}) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function emit(level: LogLevel, scope: string, msg: string, fields: LogFields | undefined): void {
  if (ORDER[level] < ORDER[configuredLevel()]) return;

  const requestId = currentRequestId();
  const extra = fields ? normalise(fields) : {};
  const line = jsonOutput()
    ? JSON.stringify({
      level,
      time: new Date().toISOString(),
      scope,
      msg,
      ...(requestId ? { requestId } : {}),
      ...extra,
    })
    // Keeps the `[scope] message` shape this codebase already used, so a
    // terminal reads the same as it did before.
    : `[${scope}] ${msg}` +
      (requestId ? ` (req ${requestId})` : '') +
      (Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '');

  // console is the sink on purpose; see the header.
  if (level === 'error' || level === 'fatal') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  fatal(msg: string, fields?: LogFields): void;
}

/**
 * A logger bound to one subsystem: `createLogger('gateway')`.
 *
 * The scope replaces the `[gateway]` prefix that was hand-written into every
 * message, so it becomes a field a collector can filter on rather than a
 * substring someone has to regex out.
 */
export function createLogger(scope: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    fatal: (msg, fields) => emit('fatal', scope, msg, fields),
  };
}
