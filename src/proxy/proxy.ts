/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion */
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Config } from '../types.js'
import { CertFactory } from './certs.js'
import { UpstreamResolver } from './upstream.js'
import { Pipeline } from '../detection/pipeline.js'
import { SuppressionStore } from '../detection/suppressions.js'
import { EventBus } from '../dashboard/eventBus.js'
import { UrlClassifier } from '../detection/urlHeuristic.js'
import { DlpScanner } from '../detection/dlp/scanner.js'
import { QuotaManager } from '../detection/dos/quota.js'
import { LoopDetector } from '../detection/dos/loopDetector.js'
import { getParser } from '../detection/parsers.js'
import { TaintTracker, maskToken } from '../detection/taint.js'
import { McpScanner } from '../detection/mcp/scanner.js'
import { inspectJsonResponse, rewriteBlockedJsonResponse, createSseGate, SseGate } from '../detection/mcp/responseGate.js'
import { ChunkedDecoder } from './dechunk.js'
import { SandboxDetector } from '../detection/sandbox.js'
import { StringDecoder } from 'node:string_decoder'
import zlib from 'node:zlib'
import { identifyService, AI_PROVIDER_INTERCEPT_DOMAINS } from '../config/providers.js'
import { scanResponseExfil, neutralizeExfil } from '../detection/responseExfil.js'
import { detectHarmfulCompliance } from '../detection/responseHarm.js'

/**
 * Decompress a fully-buffered response body by its Content-Encoding so the
 * inspected paths (MCP tool rewrite, response-exfil scan) see plaintext. Some
 * servers send raw (headerless) deflate, so fall back to inflateRaw. Throws on a
 * corrupt/truncated stream — the caller forwards the original bytes on failure.
 */
function decompressBody(buf: Buffer, encoding: string): Buffer {
  const enc = encoding.toLowerCase().trim()
  if (!enc || enc === 'identity') return buf
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf)
  if (enc === 'br') return zlib.brotliDecompressSync(buf)
  if (enc === 'deflate') {
    try { return zlib.inflateSync(buf) } catch { return zlib.inflateRawSync(buf) }
  }
  return buf // unknown encoding — treat as opaque
}

/**
 * Raised when the upstream socket goes idle for longer than `upstreamTimeoutMs`.
 * Carries enough context (host, port, how long we waited, and whether we had
 * already started receiving the response) to make the console line actionable
 * instead of an anonymous "upstream timeout".
 */
class UpstreamTimeoutError extends Error {
  constructor(
    public readonly host: string,
    public readonly port: number,
    public readonly waitedMs: number,
    public readonly timeoutMs: number,
    public readonly phase: 'awaiting response headers' | 'mid-response stall',
  ) {
    super(`upstream timeout after ${waitedMs}ms (${phase}) — ${host}:${port}, limit ${timeoutMs}ms`)
    this.name = 'UpstreamTimeoutError'
  }
}

/**
 * Parse a CONNECT request target (`host:port`) into hostname and port.
 * Handles the case where no port is supplied (e.g. `CONNECT api.anthropic.com`),
 * which previously truncated the final character of the hostname.
 */
export function parseConnectTarget(url: string): { hostname: string; port: number } {
  const colonIdx = url.lastIndexOf(':')
  // No colon, or a lone trailing colon → treat the whole string as the hostname.
  if (colonIdx === -1) return { hostname: url, port: 443 }
  const hostname = url.slice(0, colonIdx)
  const port = parseInt(url.slice(colonIdx + 1), 10) || 443
  return { hostname, port }
}

/** Strip the IPv4-mapped IPv6 prefix so the dashboard shows a clean address. */
export function normalizeIp(addr: string | undefined): string {
  return (addr ?? '').replace(/^::ffff:/, '') || 'unknown'
}

/** Max bytes of request body retained on a traffic metric for the detail view. */
const TRAFFIC_BODY_CAP = 16 * 1024

/**
 * Headers whose VALUE may carry a credential. We keep the header NAME (so the
 * detail view shows that auth was present) but replace the value with a marker —
 * the raw secret must never reach the dashboard or the event ring buffer.
 */
const SENSITIVE_HEADERS = new Set(['authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie', 'proxy-authorization', 'x-goog-api-key'])

/**
 * Cheap check that a request body is a structured JSON object — used to flag
 * "LLM-looking POST to an intercepted host that no parser recognized" without
 * warning on every binary upload or form post. Bounds the parse to keep a huge
 * body from blocking the event loop.
 */
function looksLikeJsonBody(body: string): boolean {
  const t = body.trimStart()
  if (!t.startsWith('{')) return false
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Known non-LLM JSON endpoints on intercepted hosts: telemetry, analytics, and
 * event-logging batches that ride the same hosts as the model APIs but carry no
 * prompt. They are JSON POSTs, so they would otherwise trip the Stage 0.9
 * "unrecognized LLM endpoint" warn as pure noise. Matched on the path suffix
 * (query string stripped) so we don't surface them as missing parsers.
 */
const NON_LLM_JSON_PATH_SUFFIXES = [
  '/api/event_logging/v2/batch',
  '/api/event_logging',
]

function isKnownNonLlmEndpoint(path: string): boolean {
  const p = (path.split('?')[0] ?? '')
  return NON_LLM_JSON_PATH_SUFFIXES.some(suffix => p.endsWith(suffix))
}

/** Return a shallow copy of the request headers with secret values redacted. */
export function sanitizeHeaders(headers: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue
    const value = Array.isArray(v) ? v.join(', ') : String(v)
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase()) ? '«redacted»' : value
  }
  return out
}

export class ProxyServer {
  private server: http.Server
  private certFactory: CertFactory
  private resolver: UpstreamResolver
  private pipeline: Pipeline
  // Every defense scanner is constructed unconditionally; whether it RUNS is
  // decided per-request against the live `config.*.enabled` flag (see the gates
  // in handleConnect/handleRequest). The proxy and dashboard share one Config
  // object in this process, so a Settings-tab toggle takes effect on the next
  // request with no restart.
  private urlClassifier: UrlClassifier
  private dlp: DlpScanner
  private quota: QuotaManager
  private loop: LoopDetector
  private mcp: McpScanner
  private taint: TaintTracker
  private sandbox: SandboxDetector
  private eventBus: EventBus
  private config: Config

  // Optional so every existing call site (tests, scripts) that doesn't care
  // about sharing the suppression store across Pipeline instances is
  // unaffected. When provided (see cli/start.ts), the SAME store backs both
  // this proxy's live-traffic pipeline and the dashboard's playground
  // pipeline, so a false-positive marked from the dashboard actually
  // suppresses future real traffic, not just the dashboard's own test runs.
  constructor(config: Config, eventBus: EventBus, suppressions?: SuppressionStore) {
    this.config = config
    this.eventBus = eventBus
    this.certFactory = new CertFactory()
    this.resolver = new UpstreamResolver(config.proxy)
    this.pipeline = new Pipeline(config, partial => eventBus.emit(partial), suppressions)
    this.urlClassifier = new UrlClassifier(config.proxy.urlFilter)
    this.dlp = new DlpScanner(config.dlp)
    this.quota = new QuotaManager(config.dos)
    this.loop = new LoopDetector()
    this.mcp = new McpScanner(config, this.dlp)
    // Taint tracker treats the configured provider/target hosts as benign so a
    // provider domain mentioned in a tool result doesn't taint the next
    // legitimate request to that same provider.
    this.taint = new TaintTracker(config.targets)
    this.sandbox = new SandboxDetector()
    this.server = http.createServer()
  }

  private sinkholeServer: tls.Server | null = null

  async init(): Promise<void> { await this.pipeline.init() }

  start(): void {
    this.server.on('connect', (req, socket, head) => {
      void this.handleConnect(req, socket as net.Socket, head)
    })
    // bindHost defaults to local-only; standalone mode sets it to 0.0.0.0 so
    // remote clients can reach the proxy.
    this.server.listen(this.config.proxy.port, this.config.proxy.bindHost ?? '127.0.0.1')
  }

  startSinkhole(httpsPort: number): void {
    const sinkholeServer = tls.createServer({
      SNICallback: (serverName, cb) => {
        try {
          const creds = this.certFactory.getHostCert(serverName)
          cb(null, tls.createSecureContext({ key: creds.key, cert: creds.cert }))
        } catch (err) { cb(err as Error) }
      },
    })

    sinkholeServer.on('secureConnection', (tlsSocket: tls.TLSSocket) => {
      const hostname = tlsSocket.servername || this.config.targets[0] || 'api.anthropic.com'
      const innerServer = http.createServer()
      innerServer.emit('connection', tlsSocket)
      innerServer.on('request', async (innerReq: http.IncomingMessage, innerRes: http.ServerResponse) => {
        try {
          await this.handleRequest(hostname, 443, innerReq, innerRes)
        } catch (err) {
          this.logRequestError('sinkhole', hostname, innerReq, err)
          if (!innerRes.headersSent) {
            innerRes.writeHead(502, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'proxy error' }))
          }
        }
      })
    })

    sinkholeServer.listen(httpsPort, '127.0.0.1')
    sinkholeServer.on('error', (err) => console.error('[sinkhole] server error:', err))
    this.sinkholeServer = sinkholeServer
  }

  stop(): Promise<void> {
    const closes: Promise<void>[] = [
      new Promise(resolve => this.server.close(() => resolve())),
    ]
    if (this.sinkholeServer) {
      closes.push(new Promise(resolve => this.sinkholeServer!.close(() => resolve())))
    }
    return Promise.all(closes).then(() => undefined)
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, _head: Buffer): Promise<void> {
    const { hostname, port } = parseConnectTarget(req.url ?? '')
    const sb = this.sandbox.detect(req.headers['user-agent'], clientSocket.remoteAddress)

    // Tenant/regional hosts (Azure OpenAI resources, regional Vertex
    // endpoints) can't be enumerated in `targets`, so their domain suffixes
    // are matched here in addition to the configured targets. Configurable via
    // proxy.interceptDomains; the registry list is the fallback when the field
    // is absent (hand-built configs), so out-of-box behaviour never regresses.
    // FAIL-SAFE: when bypass is on, behave as a transparent tunnel for EVERY host
    // — never MITM, never run taint/url-filter, never block. One env flag
    // (LLM_FW_BYPASS=true) restores full connectivity if a detection change goes
    // wrong, so the operator can never be locked out of their LLM APIs.
    const bypass = this.config.proxy.bypass === true
    const interceptDomains = this.config.proxy.interceptDomains ?? AI_PROVIDER_INTERCEPT_DOMAINS
    const isTarget = !bypass && (
      this.config.targets.some(t => hostname === t || hostname.endsWith('.' + t)) ||
      interceptDomains.some(d => hostname === d || hostname.endsWith('.' + d))
    )

    if (!isTarget) {
      // Cross-turn taint (host level). The destination hostname is visible at
      // CONNECT even for tunneled hosts we never decrypt. If this host first
      // appeared inside untrusted tool-result content this session, the agent is
      // dialing a destination it was told to use by untrusted data — a strong
      // exfil signal that needs no body inspection. (Only the hostname is
      // checkable here; path/query taint is caught in handleRequest for
      // inspected hosts.)
      if (!bypass && this.config.taint?.enabled) {
        const sessionKey = normalizeIp(clientSocket.remoteAddress) ?? 'unknown'
        const findings = this.taint.checkSink(sessionKey, hostname, Date.now())
        if (findings.length) {
          const f = findings[0]!
          const detail = `Outbound connection to a host named in untrusted content: ${maskToken(f.token)}`
          if (this.config.taint?.mode === 'block') {
            const errBody = JSON.stringify({ error: 'tainted destination blocked', category: f.category })
            clientSocket.write(
              `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(errBody)}\r\nConnection: close\r\n\r\n${errBody}`
            )
            clientSocket.destroy()
            this.eventBus.emit({
              stage: 'none', score: 100, similarity: 0,
              target: hostname, method: 'CONNECT', path: '/',
              payload_preview: detail, payload_full: hostname,
              action: 'blocked', kind: 'taint',
              sandboxClient: sb.client, isSandboxed: sb.sandboxed, sandboxConfidence: sb.confidence,
            })
            return
          }
          this.eventBus.emit({
            stage: 'none', score: 50, similarity: 0,
            target: hostname, method: 'CONNECT', path: '/',
            payload_preview: detail, payload_full: hostname,
            action: 'warned', kind: 'taint',
            sandboxClient: sb.client, isSandboxed: sb.sandboxed, sandboxConfidence: sb.confidence,
          })
          // audit mode: fall through to normal tunnel handling
        }
      }

      // URL filter: check hostname before establishing any tunnel
      if (!bypass && this.config.proxy.urlFilter.enabled) {
        const urlResult = this.urlClassifier.classify(hostname)
        if (urlResult.action === 'block') {
          const body = JSON.stringify({ error: 'url blocked', reason: urlResult.reason })
          clientSocket.write(
            `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
          )
          clientSocket.destroy()
          this.eventBus.emit({
            stage: 'url-filter',
            score: 100,
            similarity: 0,
            target: hostname,
            method: 'CONNECT',
            path: '/',
            payload_preview: hostname,
            payload_full: hostname,
            action: 'blocked',
            kind: 'url',
            urlBlockReason: urlResult.reason,
            sandboxClient: sb.client,
            isSandboxed: sb.sandboxed,
            sandboxConfidence: sb.confidence
          })
          return
        }
      }

      // Direct tunnel — no inspection
      const upstream = net.createConnection({ host: hostname, port })

      let trafficEmitted = false
      const emitTunnelTraffic = () => {
        if (trafficEmitted) return
        trafficEmitted = true
        this.eventBus.emitTraffic({
          service: identifyService(hostname),
          host: hostname,
          bytesSent: upstream.bytesWritten || 0,
          bytesReceived: upstream.bytesRead || 0,
          fromIp: normalizeIp(clientSocket.remoteAddress),
          inspected: false,
        })
      }

      clientSocket.on('close', emitTunnelTraffic)
      upstream.on('close', emitTunnelTraffic)

      clientSocket.on('error', () => upstream.destroy())
      upstream.on('error', () => clientSocket.destroy())
      upstream.once('connect', () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        upstream.pipe(clientSocket)
        clientSocket.pipe(upstream)
      })
      return
    }

    // Intercept and inspect
    try {
      const creds = this.certFactory.getHostCert(hostname)
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')

      const tlsSocket = new tls.TLSSocket(clientSocket, {
        isServer: true,
        key: creds.key,
        cert: creds.cert,
      })
      tlsSocket.on('error', () => clientSocket.destroy())

      const innerServer = http.createServer()
      innerServer.emit('connection', tlsSocket)
      innerServer.on('request', async (innerReq, innerRes) => {
        try { await this.handleRequest(hostname, port, innerReq, innerRes) }
        catch (err) {
          this.logRequestError('proxy', hostname, innerReq, err)
          if (!innerRes.headersSent) {
            innerRes.writeHead(502, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'proxy error' }))
          }
        }
      })
    } catch (err) {
      console.error(`[proxy] CONNECT error for ${hostname}:${port}: ${(err as Error)?.message ?? String(err)}`)
      clientSocket.destroy()
    }
  }

  private async handleRequest(hostname: string, port: number, innerReq: http.IncomingMessage, innerRes: http.ServerResponse): Promise<void> {
    {
      const dosMethod = innerReq.method ?? 'GET'
      const dosPath = innerReq.url ?? '/'

      const sb = this.sandbox.detect(innerReq.headers['user-agent'], innerReq.socket.remoteAddress)

      const emitEvent = (ev: Parameters<EventBus['emit']>[0]) => {
        this.eventBus.emit({
          ...ev,
          sandboxClient: sb.client,
          isSandboxed: sb.sandboxed,
          sandboxConfidence: sb.confidence
        })
      }

      // Stage -1 — Cost control / agentic DoS circuit breaker. The RPM and
      // session-budget checks run BEFORE the body is buffered so a run-away
      // agent is throttled as cheaply as possible.
      if (this.config.dos.enabled) {
        const q = this.quota.checkRpm()
        if (!q.allowed) {
          innerRes.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(q.retryAfterSec),
          })
          innerRes.end(JSON.stringify({ error: 'rate limit exceeded', retryAfter: q.retryAfterSec }))
          emitEvent({
            stage: 'dos',
            score: 100,
            similarity: 0,
            target: hostname,
            method: dosMethod,
            path: dosPath,
            payload_preview: 'rate limit exceeded',
            payload_full: 'rate limit exceeded',
            action: 'blocked',
            kind: 'dos',
            dosReason: 'rate limit exceeded',
          })
          innerReq.destroy()
          return
        }
        if (this.quota.sessionExceeded()) {
          innerRes.writeHead(429, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'session token budget exceeded' }))
          emitEvent({
            stage: 'dos',
            score: 100,
            similarity: 0,
            target: hostname,
            method: dosMethod,
            path: dosPath,
            payload_preview: 'session token budget exceeded',
            payload_full: 'session token budget exceeded',
            action: 'blocked',
            kind: 'dos',
            dosReason: 'session token budget exceeded',
          })
          innerReq.destroy()
          return
        }
      }

      // Stage 0.1 — Outbound URL exfiltration screening. The decrypted
      // request path/query is available the moment the request line is
      // parsed, so screen it BEFORE buffering the body or running the
      // pipeline: an exfil path (e.g. a query string carrying stolen data)
      // is then rejected as early and cheaply as possible.
      if (this.config.proxy.urlFilter.enabled) {
        const pathResult = this.urlClassifier.classifyPath(dosPath)
        if (pathResult.action === 'block') {
          innerRes.writeHead(403, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'url blocked', reason: pathResult.reason }))
          emitEvent({
            stage: 'url-filter',
            score: 100,
            similarity: 0,
            target: hostname,
            method: dosMethod,
            path: dosPath,
            payload_preview: dosPath.slice(0, 120),
            payload_full: dosPath,
            action: 'blocked',
            kind: 'url',
            urlBlockReason: pathResult.reason,
          })
          innerReq.destroy()
          return
        }
      }

      const chunks: Buffer[] = []
      let accumulatedBody = ''
      let blocked = false
      let totalBytes = 0
      const maxBodyBytes = this.config.proxy.maxBodyBytes

      // Intercept request stream to check chunks on the fly
      innerReq.on('data', (chunk: Buffer) => {
        if (blocked) return

        // Bound buffered body size to prevent memory-exhaustion DoS from an
        // oversized (or unbounded streaming) payload.
        totalBytes += chunk.length
        if (maxBodyBytes > 0 && totalBytes > maxBodyBytes) {
          blocked = true
          innerRes.writeHead(413, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'request body too large', limit: maxBodyBytes }))
          innerReq.destroy()
          return
        }

        chunks.push(Buffer.from(chunk))
        accumulatedBody += chunk.toString('utf-8')

        void this.pipeline.checkPartial(
          innerReq.url ?? '/',
          accumulatedBody,
          { target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/' }
        ).then((partialResult) => {
          if (partialResult && partialResult.action === 'block' && !blocked) {
            blocked = true
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'prompt injection detected', stage: partialResult.stage, score: partialResult.score }))
            innerReq.destroy()
          }
        }).catch(() => { })
      })

      await new Promise<void>((resolve, reject) => {
        innerReq.on('end', () => resolve())
        innerReq.on('error', (err) => reject(err))
      })

      if (blocked) return

      // Keep the original bytes for forwarding; the utf-8 decode is used
      // ONLY for text-based detection. Decoding binary payloads (e.g. image
      // uploads) to a string and back would replace invalid byte sequences
      // with U+FFFD, corrupting the request and changing its length.
      let bodyBuf = Buffer.concat(chunks)
      let body = bodyBuf.toString('utf-8')

      // Stage 0 — Data Loss Prevention. Only LLM JSON requests (those with a
      // registered parser) are scanned, so binary/file uploads are skipped.
      const method = innerReq.method ?? 'GET'
      const dlpPath = innerReq.url ?? '/'

      // Session identity shared across the proxy's per-client state (taint
      // tracking below, and — opt-in — the pipeline's cross-request crescendo
      // memory): the client's normalized source IP. Computed once here so both
      // consumers key on the exact same identity.
      const sessionKey = normalizeIp(innerReq.socket.remoteAddress)

      // Stage T — Cross-turn taint tracking (information flow, not content
      // classification). Flags when a distinctive token (host / secret) that
      // first entered via an untrusted tool result in a PRIOR request reappears
      // in this request's destination or path — untrusted data now driving an
      // outbound action, independent of how the injection was phrased. Runs for
      // every host (the exfil sink is usually NOT an LLM provider). Sink-checked
      // first, then this request's own tool results are recorded, so a request
      // can never taint and then flag itself.
      if (this.config.taint?.enabled) {
        const now = Date.now()
        const findings = this.taint.checkSink(sessionKey, `${hostname} ${dlpPath}`, now)
        if (findings.length) {
          const f = findings[0]!
          const detail = `Untrusted ${f.category} from a prior tool result reused in outbound request: ${maskToken(f.token)}`
          if (this.config.taint?.mode === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'tainted data flow blocked', category: f.category }))
            emitEvent({
              stage: 'none', score: 100, similarity: 0,
              target: hostname, method, path: dlpPath,
              payload_preview: detail, payload_full: `${method} ${hostname}${dlpPath}`,
              action: 'blocked', kind: 'taint',
            })
            return
          }
          emitEvent({
            stage: 'none', score: 50, similarity: 0,
            target: hostname, method, path: dlpPath,
            payload_preview: detail, payload_full: `${method} ${hostname}${dlpPath}`,
            action: 'warned', kind: 'taint',
          })
        }
        const taintParser = getParser(dlpPath)
        if (taintParser) {
          const untrusted = taintParser.extractToolResults(body).map(t => t.result).join('\n')
          if (untrusted) this.taint.recordSource(sessionKey, untrusted, now)
        }
      }

      if (this.config.dlp.enabled && getParser(dlpPath) !== null) {
        const findings = this.dlp.scan(body)
        if (findings.length) {
          // NEVER log the raw secret value — only its type(s).
          const types = Array.from(new Set(findings.map(f => f.type)))
          const typeSummary = types.join(', ')
          const mode = this.config.dlp.mode

          if (mode === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'sensitive data detected', type: findings[0]!.type }))
            emitEvent({
              stage: 'dlp',
              score: 100,
              similarity: 0,
              target: hostname,
              method,
              path: dlpPath,
              payload_preview: typeSummary,
              payload_full: typeSummary,
              action: 'blocked',
              kind: 'dlp',
              dlpType: findings[0]!.type,
            })
            return
          }

          if (mode === 'redact') {
            const redacted = this.dlp.redact(body, findings)
            bodyBuf = Buffer.from(redacted, 'utf-8')
            body = redacted
          }

          // 'redact' and 'audit' both emit a warn event and continue.
          emitEvent({
            stage: 'dlp',
            score: 100,
            similarity: 0,
            target: hostname,
            method,
            path: dlpPath,
            payload_preview: typeSummary,
            payload_full: typeSummary,
            action: 'warned',
            kind: 'dlp',
            dlpType: findings[0]!.type,
          })
        }
      }

      // Stage 0.5 — Behavioral loop detection. Only LLM JSON requests (those
      // with a registered parser) are tracked, mirroring DLP scoping. An
      // agent stuck resending the identical body trips the circuit breaker.
      if (this.config.dos.enabled && this.config.dos.loopDetectionEnabled && getParser(dlpPath) !== null) {
        if (this.loop.isLooping(body)) {
          innerRes.writeHead(429, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'Agent Loop Detected' }))
          emitEvent({
            stage: 'dos',
            score: 100,
            similarity: 0,
            target: hostname,
            method,
            path: dlpPath,
            payload_preview: body.slice(0, 120),
            payload_full: body,
            action: 'blocked',
            kind: 'dos',
            dosReason: 'Agent Loop Detected',
          })
          return
        }
        this.loop.record(body)
      }

      // Stage 0.9 — Visibility for unrecognized LLM endpoints. We only MITM
      // target hosts, so a POST with a JSON body that no parser recognizes is an
      // LLM-looking request the injection pipeline silently passes — e.g. a
      // newer/agentic endpoint (Google Antigravity / Cloud Code Assist, a Vertex
      // path variant). Surface it as a non-blocking warn so it appears in Live
      // Traffic and someone can add a parser, instead of it vanishing.
      if (getParser(dlpPath) === null && method === 'POST' && looksLikeJsonBody(body) && !isKnownNonLlmEndpoint(dlpPath)) {
        emitEvent({
          stage: 'none',
          score: 0,
          similarity: 0,
          target: hostname,
          method,
          path: dlpPath,
          // Path is the actionable signal; the body is unparsed and has not been
          // DLP-scanned, so don't dump it (it may carry secrets).
          payload_preview: `Unrecognized LLM endpoint — body not inspected: ${method} ${dlpPath}`,
          payload_full: `${method} ${dlpPath}`,
          action: 'warned',
          kind: 'unparsed',
        })
      }

      const result = await this.pipeline.run(
        innerReq.url ?? '/',
        body,
        {
          target: hostname,
          method: innerReq.method ?? 'GET',
          path: innerReq.url ?? '/',
          sandboxClient: sb.client,
          isSandboxed: sb.sandboxed,
          sandboxConfidence: sb.confidence,
          sessionKey,
        }
      )

      if (result.action === 'block') {
        innerRes.writeHead(403, { 'Content-Type': 'application/json' })
        innerRes.end(JSON.stringify({ error: 'prompt injection detected', stage: result.stage, score: result.score }))
        return
      }

      // Stage 4 - MCP Request Validation. When the request exposes tools, the
      // response may carry tool_use invocations, so flag it for inbound MCP
      // inspection in forwardRequest (normal chat traffic stays on the fast path).
      let mcpInspectResponse = false
      if (this.config.mcp.enabled && getParser(innerReq.url ?? '/') !== null) {
        const parser = getParser(innerReq.url ?? '/')!
        const tools = parser.extractTools(body)
        if (tools.length > 0) {
          mcpInspectResponse = true
          const defResult = this.mcp.checkToolDefinitions(tools)
          if (defResult.action === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: defResult.reason }))
            emitEvent({
              stage: 'mcp-filter',
              score: 100, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Blocked tool definition`, payload_full: JSON.stringify(tools),
              action: 'blocked', kind: 'mcp'
            })
            return
          } else if (defResult.audit) {
            emitEvent({
              stage: 'mcp-filter', score: 50, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Audit: would block tool definition (${defResult.reason ?? ''})`, payload_full: JSON.stringify(tools),
              action: 'warned', kind: 'mcp'
            })
          } else {
            emitEvent({
              stage: 'mcp-filter', score: 0, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Exposed ${tools.length} tools to LLM`, payload_full: JSON.stringify(tools),
              action: 'passed', kind: 'mcp'
            })
          }
        }

        const toolResults = parser.extractToolResults(body)
        for (const tr of toolResults) {
          const resResult = this.mcp.checkToolResult(tr.toolUseId, tr.result)
          if (resResult.action === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: resResult.reason }))
            emitEvent({
              stage: 'mcp-filter',
              score: 100, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Blocked tool result (id ${tr.toolUseId})`, payload_full: tr.result,
              action: 'blocked', kind: 'mcp'
            })
            return
          } else if (resResult.audit) {
            emitEvent({
              stage: 'mcp-filter', score: 50, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Audit: would block tool result (id ${tr.toolUseId}) — ${resResult.reason ?? ''}`, payload_full: tr.result,
              action: 'warned', kind: 'mcp'
            })
          } else {
            emitEvent({
              stage: 'mcp-filter', score: 0, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Tool result returned (id ${tr.toolUseId})`, payload_full: tr.result,
              action: 'passed', kind: 'mcp'
            })
          }
        }
      }

      const isLlmRequest = getParser(innerReq.url ?? '/') !== null

      const bytesReceived = await this.forwardRequest(hostname, port, innerReq, bodyBuf, innerRes, isLlmRequest, mcpInspectResponse)
      // `body` is the decoded request payload, already DLP-redacted in place when
      // a finding triggered redact mode, so no raw secret is exposed to the UI.
      const bodyTruncated = body.length > TRAFFIC_BODY_CAP
      this.eventBus.emitTraffic({
        service: identifyService(hostname),
        host: hostname,
        bytesSent: bodyBuf.length,
        bytesReceived,
        fromIp: normalizeIp(innerReq.socket.remoteAddress),
        inspected: true,
        method: innerReq.method ?? 'GET',
        path: innerReq.url ?? '/',
        reqHeaders: sanitizeHeaders(innerReq.headers),
        requestBody: bodyTruncated ? body.slice(0, TRAFFIC_BODY_CAP) : body,
        bodyTruncated,
      })

      // Account the INPUT (request) tokens against the budget; forwardRequest
      // additionally accounts the response tokens as they stream back.
      if (this.config.dos.enabled && isLlmRequest) this.quota.addTokens(this.quota.estimateTokens(body))
    }
  }

  // Push streamed SSE text through the MCP gate, forward the (possibly filtered)
  // result to the agent, emit audit events, and return the bytes forwarded.
  private gateSse(gate: SseGate, text: string, res: http.ServerResponse, req: http.IncomingMessage, hostname: string): number {
    const { forward, decisions } = gate.push(text)
    for (const d of decisions) {
      if (d.action === 'block') {
        const preview = d.reason ? `Blocked tool invocation: ${d.toolName} (${d.reason})` : `Blocked tool invocation: ${d.toolName}`
        this.emitMcp('blocked', preview, forward, req, hostname, d.toolName, d.reason)
      } else if (d.audit) {
        const preview = d.reason ? `Audit: would block ${d.toolName} (${d.reason})` : `Audit: would block ${d.toolName}`
        this.emitMcp('warned', preview, forward, req, hostname, d.toolName, d.reason)
      } else {
        this.emitMcp('passed', `Tool invoked by LLM: ${d.toolName}`, forward, req, hostname, d.toolName)
      }
    }
    if (forward) { res.write(Buffer.from(forward, 'utf8')); return Buffer.byteLength(forward) }
    return 0
  }

  private emitMcp(action: 'blocked' | 'warned' | 'passed', preview: string, full: string, req: http.IncomingMessage, hostname: string, toolName?: string, mcpRule?: string): void {
    this.eventBus.emit({
      stage: 'mcp-filter',
      score: action === 'blocked' ? 100 : action === 'warned' ? 50 : 0,
      similarity: 0,
      target: hostname,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      payload_preview: preview,
      payload_full: full,
      action,
      kind: 'mcp',
      ...(toolName ? { mcpTool: toolName } : {}),
      ...(mcpRule ? { mcpRule } : {}),
    })
  }

  /**
   * Scan decoded response text for data-exfiltration markup (markdown/HTML image
   * & link URLs to exfil sinks, judged by the URL classifier). Emits an event per
   * finding. Returns the neutralized text when blocking is enabled AND the body is
   * still rewritable (buffered, non-streamed); otherwise null (audit / can't strip).
   */
  private runResponseExfilScan(text: string, req: http.IncomingMessage, hostname: string, canNeutralize: boolean): string | null {
    if (!this.config.responseScan?.enabled) return null
    const findings = scanResponseExfil(text, (h, p) => this.urlClassifier.classifyDetailed(h, p).action === 'block')
    if (!findings.length) return null
    const block = this.config.responseScan.mode === 'block' && canNeutralize
    for (const f of findings) {
      this.eventBus.emit({
        stage: 'response-exfil',
        score: 100,
        similarity: 0,
        target: hostname,
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        payload_preview: `${block ? 'Blocked' : 'Detected'} response exfil (${f.kind}): ${f.url.slice(0, 160)}`,
        payload_full: f.url,
        action: block ? 'blocked' : 'warned',
        kind: 'response-exfil',
        exfilUrl: f.url,
      })
    }
    return block ? neutralizeExfil(text, findings) : null
  }

  /**
   * Audit-only defense-in-depth: flag a response that produced harmful HOW-TO
   * content (a jailbreak the input stages missed and the model complied with).
   * Never blocks — emits a warn event so the operator sees the miss. Cheap
   * co-occurrence scan over the already-decoded text.
   */
  private runResponseHarmScan(text: string, req: http.IncomingMessage, hostname: string): void {
    if (!this.config.responseScan?.enabled || this.config.responseScan.harmfulCompliance === false) return
    const finding = detectHarmfulCompliance(text)
    if (!finding) return
    this.eventBus.emit({
      stage: 'none',
      score: 0,
      similarity: 0,
      target: hostname,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      payload_preview: `Possible harmful compliance in response (${finding.term}): ${finding.snippet.slice(0, 120)}`,
      payload_full: finding.snippet,
      action: 'warned',
      kind: 'response-harm',
    })
  }

  // One-line, context-rich console output for failed requests. Expected
  // operational conditions (upstream idle timeouts) log as a concise warning;
  // genuinely unexpected errors keep their stack so they stay debuggable.
  private logRequestError(scope: string, hostname: string, req: http.IncomingMessage, err: unknown): void {
    const where = `${req.method ?? 'GET'} ${hostname}${req.url ?? '/'}`
    if (err instanceof UpstreamTimeoutError) {
      console.warn(`[${scope}] ${err.message} (${where}). The provider sent no data within the idle window; raise proxy.upstreamTimeoutMs if long non-streaming completions are expected.`)
      return
    }
    const e = err as Error
    console.error(`[${scope}] request error (${where}): ${e?.message ?? String(err)}`)
    if (e?.stack) console.error(e.stack)
  }

  private async forwardRequest(hostname: string, port: number, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, isLlmRequest: boolean = true, mcpInspect: boolean = false): Promise<number> {
    const ip = await this.resolver.resolve(hostname)
    return new Promise<number>((resolve, reject) => {
      const startedAt = Date.now()
      const upstream = tls.connect({ host: ip, port, servername: hostname }, () => {
        upstream.write(req.method + ' ' + (req.url ?? '/') + ' HTTP/1.1\r\n')
        const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'accept-encoding'])
        const headers = { ...req.headers, host: hostname }
        for (const [k, v] of Object.entries(headers)) {
          if (v && !HOP_BY_HOP.has(k.toLowerCase())) upstream.write(k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n')
        }
        upstream.write('Content-Length: ' + body.length + '\r\n')
        upstream.write('Accept-Encoding: identity\r\n')
        upstream.write('Connection: close\r\n')
        upstream.write('\r\n')
        if (body.length) upstream.write(body)
      })

      // Idle timeout: fires when the upstream socket sees no I/O for the
      // configured window. Note this is an *inactivity* timer — for
      // non-streaming completions the provider holds the connection silent
      // until the whole body is generated, so a long generation legitimately
      // looks idle. We report how long we actually waited and whether the
      // response had started so the cause is obvious in the console.
      upstream.setTimeout(this.config.proxy.upstreamTimeoutMs, () => {
        const waited = Date.now() - startedAt
        upstream.destroy()
        reject(new UpstreamTimeoutError(hostname, port, waited, this.config.proxy.upstreamTimeoutMs,
          headersDone ? 'mid-response stall' : 'awaiting response headers'))
      })
      // Disarm the idle timer and surface the error once. Without clearing the
      // timer on settle, a socket lingering idle after a completed response
      // could fire a spurious "upstream timeout" against an already-resolved
      // request.
      upstream.on('error', (err: Error) => { upstream.setTimeout(0); reject(err) })

      // Parse and stream the response. When the request exposed MCP tools, the
      // response may carry tool_use invocations — inspect them BEFORE the bytes
      // reach the agent (see DESIGN-mcp-response.md): non-streaming JSON is
      // buffered and rewritten tool-free; streaming SSE is gated per tool block.
      // Everything else streams straight through untouched.
      // Inspected modes (MCP tool rewrite + response-exfil scan) need the
      // DECODED, DECOMPRESSED payload. JSON: buffer raw bytes, decompress+inspect
      // at end. SSE: gate/forward live, scan the accumulated text at flush.
      // Everything else streams through untouched.
      const parser = getParser(req.url ?? '/')
      const mcpActive = !!(this.config.mcp.enabled && mcpInspect && parser)
      const responseScanActive = this.config.responseScan?.enabled === true
      const wantInspect = mcpActive || responseScanActive
      const maxResp = this.config.proxy.maxBodyBytes

      let headersDone = false
      let rawHeaders = ''
      let respBodyBytes = 0
      // 'raw-stream' is the fail-open passthrough after an oversized inspected body.
      let mode: 'passthrough' | 'json' | 'sse' | 'raw-stream' = 'passthrough'
      let status = 200
      const respHeaders: Record<string, string> = {}
      let cenc = ''
      const jsonChunks: Buffer[] = []
      let jsonRawLen = 0
      let sseText = ''
      let gate: SseGate | null = null
      let dechunker: ChunkedDecoder | null = null
      const decoder = new StringDecoder('utf8')

      // Inspected modes forward decompressed plaintext, so drop framing AND
      // content-encoding (else the client would try to gunzip plaintext).
      const inspectedHeaders = (): Record<string, string> => {
        const h = { ...respHeaders }
        delete h['content-length']; delete h['transfer-encoding']; delete h['content-encoding']
        return h
      }
      // Fail-open passthrough of still-encoded bytes: drop framing but KEEP
      // content-encoding so the client decodes them itself.
      const failoverHeaders = (): Record<string, string> => {
        const h = { ...respHeaders }
        delete h['content-length']; delete h['transfer-encoding']
        return h
      }
      // SSE: accumulate decoded text for the exfil scan, then forward — through
      // the MCP gate when active, else verbatim.
      const feedSse = (text: string) => {
        if (sseText.length < maxResp) sseText += text
        if (gate) respBodyBytes += this.gateSse(gate, text, res, req, hostname)
        else if (text) { res.write(Buffer.from(text, 'utf8')); respBodyBytes += Buffer.byteLength(text) }
      }

      upstream.on('data', (chunk: Buffer) => {
        if (!headersDone) {
          rawHeaders += chunk.toString('binary')
          const sep = rawHeaders.indexOf('\r\n\r\n')
          if (sep === -1) return
          headersDone = true
          const headerPart = rawHeaders.slice(0, sep)
          const bodyStart = Buffer.from(rawHeaders.slice(sep + 4), 'binary')
          const lines = headerPart.split('\r\n')
          status = parseInt((lines[0] ?? '').split(' ')[1] ?? '200', 10)
          for (const line of lines.slice(1)) {
            const ci = line.indexOf(': ')
            if (ci > 0) respHeaders[line.slice(0, ci).toLowerCase()] = line.slice(ci + 2)
          }
          cenc = (respHeaders['content-encoding'] ?? '').toLowerCase().trim()
          const compressed = cenc !== '' && cenc !== 'identity'

          const ctype = (respHeaders['content-type'] ?? '').toLowerCase()
          if (wantInspect && ctype.includes('text/event-stream')) {
            // Streaming decompression is unsupported — a compressed SSE stream
            // falls back to untouched passthrough rather than risk corruption.
            mode = compressed ? 'passthrough' : 'sse'
          } else if (wantInspect && ctype.includes('application/json')) {
            mode = 'json'
          }

          // Decode chunked framing so we can re-frame once (and, for JSON,
          // decompress the assembled body at end).
          if ((respHeaders['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
            dechunker = new ChunkedDecoder()
          }
          const dechunk = (raw: Buffer): Buffer => dechunker ? dechunker.push(raw) : raw

          if (mode === 'sse') {
            gate = mcpActive ? createSseGate(parser!, this.mcp) : null
            res.writeHead(status, inspectedHeaders())
            feedSse(decoder.write(dechunk(bodyStart)))
          } else if (mode === 'json') {
            const b = dechunk(bodyStart)
            if (b.length) { jsonChunks.push(b); jsonRawLen += b.length }
          } else {
            // Passthrough. Keep content-encoding (failoverHeaders) when we had to
            // dechunk; else forward bytes + original headers verbatim. Binary-safe
            // (no utf-8 round-trip) so file/image payloads survive.
            res.writeHead(status, dechunker ? failoverHeaders() : respHeaders)
            const out = dechunk(bodyStart)
            if (out.length) { res.write(out); respBodyBytes += out.length }
          }
        } else if (mode === 'sse') {
          feedSse(decoder.write(dechunker ? dechunker.push(chunk) : chunk))
        } else if (mode === 'json') {
          const b = dechunker ? dechunker.push(chunk) : chunk
          if (b.length) { jsonChunks.push(b); jsonRawLen += b.length }
          if (jsonRawLen > maxResp) {
            // Oversized — fail open: forward the still-(maybe-)encoded bytes
            // verbatim and stop inspecting.
            this.emitMcp('passed', `Response too large to inspect (${jsonRawLen}B)`, '', req, hostname)
            res.writeHead(status, failoverHeaders())
            const buffered = Buffer.concat(jsonChunks)
            if (buffered.length) { res.write(buffered); respBodyBytes += buffered.length }
            jsonChunks.length = 0
            mode = 'raw-stream'
          }
        } else if (mode === 'raw-stream') {
          const out = dechunker ? dechunker.push(chunk) : chunk
          if (out.length) { res.write(out); respBodyBytes += out.length }
        } else {
          const out = dechunker ? dechunker.push(chunk) : chunk
          if (out.length) { res.write(out); respBodyBytes += out.length }
        }
      })
      upstream.on('end', () => {
        upstream.setTimeout(0) // response complete — disarm the idle timer
        if (mode === 'json') {
          const raw = Buffer.concat(jsonChunks)
          let text: string
          try {
            text = decompressBody(raw, cenc).toString('utf8')
          } catch (err) {
            // Corrupt/truncated compressed body — forward verbatim, uninspected.
            console.warn(`[proxy] could not decompress ${cenc} response from ${hostname}${req.url ?? '/'}: ${(err as Error)?.message ?? String(err)}`)
            res.writeHead(status, failoverHeaders())
            res.end(raw)
            respBodyBytes = raw.length
            if (this.config.dos.enabled && isLlmRequest) this.quota.addTokens(Math.ceil(respBodyBytes / 4))
            resolve(respBodyBytes)
            return
          }

          let finalBody = text
          if (mcpActive && parser) {
            const { decisions, blockedNames } = inspectJsonResponse(text, parser, this.mcp)
            for (const d of decisions) {
              if (d.action === 'block') {
                this.emitMcp('blocked', d.reason ? `Blocked tool invocation: ${d.toolName} (${d.reason})` : `Blocked tool invocation: ${d.toolName}`, text, req, hostname, d.toolName, d.reason)
              } else if (d.audit) {
                this.emitMcp('warned', d.reason ? `Audit: would block ${d.toolName} (${d.reason})` : `Audit: would block ${d.toolName}`, text, req, hostname, d.toolName, d.reason)
              } else {
                this.emitMcp('passed', `Tool invoked by LLM: ${d.toolName}`, text, req, hostname, d.toolName)
              }
            }
            if (blockedNames.size > 0) finalBody = rewriteBlockedJsonResponse(finalBody, blockedNames)
          }

          // Response-exfil scan on the buffered body → can neutralize when mode=block.
          const neutralized = this.runResponseExfilScan(finalBody, req, hostname, true)
          if (neutralized !== null) finalBody = neutralized
          // Defense-in-depth: audit-only harmful-compliance scan on the response.
          this.runResponseHarmScan(finalBody, req, hostname)

          res.writeHead(status, inspectedHeaders())
          res.end(Buffer.from(finalBody, 'utf8'))
          respBodyBytes = Buffer.byteLength(finalBody)
        } else {
          if (mode === 'sse') {
            if (gate) { const tail = gate.flush(); if (tail) { res.write(tail); respBodyBytes += Buffer.byteLength(tail) } }
            // Already streamed → audit only (cannot retract sent bytes).
            this.runResponseExfilScan(sseText, req, hostname, false)
            this.runResponseHarmScan(sseText, req, hostname)
          }
          res.end()
        }
        // Account the RESPONSE size against the token budget. Runaway agents and
        // large generations rack up cost on the response side, not just input.
        if (this.config.dos.enabled && isLlmRequest) this.quota.addTokens(Math.ceil(respBodyBytes / 4))
        resolve(respBodyBytes)
      })
    })
  }
}
