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

/** The W3C trace context of a request: its trace and the caller's span. */
export interface TraceContext { traceId: string; spanId: string }

const store = new AsyncLocalStorage<{ requestId: string } & Partial<TraceContext>>();

/**
 * Run `fn` with a correlation id attached to every log record it produces,
 * however deep, and the caller's W3C trace context when it sent one (#874),
 * so a collector can join llm-fw's lines to the trace that made the request.
 * AsyncLocalStorage rather than passing an id down twenty call sites: the
 * detection pipeline does not otherwise need to know it is serving a
 * request.
 */
export function withRequestId<T>(requestId: string, fn: () => T, trace?: TraceContext | null): T {
  return store.run(trace ? { requestId, traceId: trace.traceId, spanId: trace.spanId } : { requestId }, fn);
}

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/**
 * The trace and span id of a `traceparent` header (W3C Trace Context), or
 * null when it is absent or not one: lower-case hex only, neither id all
 * zeros, version ff invalid, and only a later version than 00 may carry
 * fields after the fourth. Bounded, since the ids go into every log line.
 */
export function parseTraceparent(header: string | string[] | undefined): TraceContext | null {
  if (typeof header !== 'string' || header.length > 512) return null;
  const m = TRACEPARENT_RE.exec(header.trim());
  if (!m) return null;
  const [, version, traceId, spanId, , rest] = m;
  if (version === 'ff' || (version === '00' && rest !== undefined)) return null;
  if (traceId === ZERO_TRACE || spanId === ZERO_SPAN) return null;
  return { traceId: traceId!, spanId: spanId! };
}

/** The correlation id of the request being served, when there is one. */
export function currentRequestId(): string | undefined {
  return store.getStore()?.requestId;
}

/**
 * A request URL fit for a log line: the path and the query's parameter names,
 * every value replaced by `…`. Providers take credentials in the query
 * (Google's `?key=`, Azure's `?api-key=`, `?access_token=`), so logging
 * `req.url` whole put a key in the log whenever a request failed.
 */
export function urlForLog(url: string | undefined): string {
  if (!url) return '/';
  const q = url.indexOf('?');
  if (q === -1) return url;
  const names = url.slice(q + 1).split('&').filter(Boolean).map(p => `${p.split('=')[0] ?? ''}=…`);
  return names.length ? `${url.slice(0, q)}?${names.join('&')}` : url.slice(0, q);
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

const unpackError = (v: Error): LogFields => ({ message: v.message, name: v.name, ...(v.stack ? { stack: v.stack } : {}) });

/** Errors do not survive JSON.stringify: it yields `{}`. Unpack them. */
function normalise(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) out[k] = v instanceof Error ? unpackError(v) : v;
  return out;
}

/**
 * JSON.stringify that cannot throw on what a caller logs (#874): a reference
 * back to an ancestor becomes "[Circular]" (one seen twice elsewhere is kept),
 * a BigInt its decimal string, an Error at any depth its message, name and
 * stack. Whatever still throws (a toJSON that throws) yields null, and the
 * caller writes the record without those fields.
 */
function safeStringify(value: unknown): string | null {
  const ancestors: unknown[] = [];
  try {
    return JSON.stringify(value, function (this: unknown, _key: string, v: unknown) {
      if (typeof v === 'bigint') return v.toString();
      if (v instanceof Error) v = unpackError(v);
      if (typeof v !== 'object' || v === null) return v;
      while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
      if (ancestors.includes(v)) return '[Circular]';
      ancestors.push(v);
      return v;
    });
  } catch {
    return null;
  }
}

function emit(level: LogLevel, scope: string, msg: string, fields: LogFields | undefined): void {
  if (ORDER[level] < ORDER[configuredLevel()]) return;

  const ctx = store.getStore();
  const requestId = ctx?.requestId;
  const extra = fields ? normalise(fields) : {};
  // The envelope comes last, so a field named level, time, scope, msg,
  // requestId, traceId or spanId cannot overwrite the record's own (#874).
  const envelope = {
    level,
    time: new Date().toISOString(),
    scope,
    msg,
    ...(requestId ? { requestId } : {}),
    ...(ctx?.traceId ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
  };
  let line: string;
  if (jsonOutput()) {
    line = safeStringify({ ...extra, ...envelope })
      ?? JSON.stringify({ ...envelope, logError: 'the fields of this record could not be serialised' });
  } else {
    // Keeps the `[scope] message` shape this codebase already used, so a
    // terminal reads the same as it did before.
    const rest = Object.keys(extra).length ? safeStringify(extra) ?? '(fields could not be serialised)' : '';
    line = `[${scope}] ${msg}` + (requestId ? ` (req ${requestId})` : '') + (rest ? ` ${rest}` : '');
  }

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
