import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Config } from '../types.js'
import { CertFactory } from './certs.js'
import { UpstreamResolver } from './upstream.js'
import { Pipeline } from '../detection/pipeline.js'
import { EventBus } from '../dashboard/eventBus.js'
import { UrlClassifier } from '../detection/urlHeuristic.js'
import { DlpScanner } from '../detection/dlp/scanner.js'
import { QuotaManager } from '../detection/dos/quota.js'
import { LoopDetector } from '../detection/dos/loopDetector.js'
import { getParser } from '../detection/parsers.js'

export function identifyService(hostname: string): string {
  if (hostname.endsWith('openai.com')) return 'OpenAI'
  if (hostname.endsWith('anthropic.com')) return 'Anthropic'
  if (hostname.endsWith('googleapis.com')) return 'Google AI'
  if (hostname.endsWith('mistral.ai')) return 'Mistral'
  if (hostname.endsWith('huggingface.co')) return 'HuggingFace'
  if (hostname.endsWith('cohere.com') || hostname.endsWith('cohere.ai')) return 'Cohere'
  if (hostname === 'localhost' || hostname === '127.0.0.1' || /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return 'Local'
  return 'Custom'
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

export class ProxyServer {
  private server: http.Server
  private certFactory: CertFactory
  private resolver: UpstreamResolver
  private pipeline: Pipeline
  private urlClassifier: UrlClassifier | null
  private dlp: DlpScanner | null
  private quota: QuotaManager | null
  private loop: LoopDetector | null
  private eventBus: EventBus
  private config: Config

  constructor(config: Config, eventBus: EventBus) {
    this.config = config
    this.eventBus = eventBus
    this.certFactory = new CertFactory()
    this.resolver = new UpstreamResolver(config.proxy)
    this.pipeline = new Pipeline(config, partial => eventBus.emit(partial))
    this.urlClassifier = config.proxy.urlFilter.enabled
      ? new UrlClassifier(config.proxy.urlFilter)
      : null
    this.dlp = config.dlp?.enabled ? new DlpScanner(config.dlp) : null
    this.quota = config.dos?.enabled ? new QuotaManager(config.dos) : null
    this.loop = config.dos?.enabled ? new LoopDetector() : null
    this.server = http.createServer()
  }

  private sinkholeServer: tls.Server | null = null

  async init(): Promise<void> { await this.pipeline.init() }

  start(): void {
    this.server.on('connect', (req, socket, head) => {
      void this.handleConnect(req, socket as net.Socket, head)
    })
    this.server.listen(this.config.proxy.port)
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
          console.error('[sinkhole] request error:', err)
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

    const isTarget = this.config.targets.some(t => hostname === t || hostname.endsWith('.' + t))

    if (!isTarget) {
      // URL filter: check hostname before establishing any tunnel
      if (this.urlClassifier) {
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
          })
          return
        }
      }

      // Direct tunnel — no inspection
      const upstream = net.createConnection({ host: hostname, port })
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
          console.error('[proxy] request error:', err)
          if (!innerRes.headersSent) {
            innerRes.writeHead(502, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'proxy error' }))
          }
        }
      })
    } catch (err) {
      console.error('[proxy] CONNECT error:', err)
      clientSocket.destroy()
    }
  }

  private async handleRequest(hostname: string, port: number, innerReq: http.IncomingMessage, innerRes: http.ServerResponse): Promise<void> {
    {
      const dosMethod = innerReq.method ?? 'GET'
      const dosPath = innerReq.url ?? '/'

      // Stage -1 — Cost control / agentic DoS circuit breaker. The RPM and
      // session-budget checks run BEFORE the body is buffered so a run-away
      // agent is throttled as cheaply as possible.
      if (this.quota) {
        const q = this.quota.checkRpm()
        if (!q.allowed) {
          innerRes.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': String(q.retryAfterSec),
          })
          innerRes.end(JSON.stringify({ error: 'rate limit exceeded', retryAfter: q.retryAfterSec }))
          this.eventBus.emit({
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
          this.eventBus.emit({
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
      if (this.urlClassifier) {
        const pathResult = this.urlClassifier.classifyPath(dosPath)
        if (pathResult.action === 'block') {
          innerRes.writeHead(403, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'url blocked', reason: pathResult.reason }))
          this.eventBus.emit({
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
      innerReq.on('data', (chunk) => {
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
      if (this.dlp && getParser(dlpPath) !== null) {
        const findings = this.dlp.scan(body)
        if (findings.length) {
          // NEVER log the raw secret value — only its type(s).
          const types = Array.from(new Set(findings.map(f => f.type)))
          const typeSummary = types.join(', ')
          const mode = this.config.dlp.mode

          if (mode === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: 'sensitive data detected', type: findings[0]!.type }))
            this.eventBus.emit({
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
          this.eventBus.emit({
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
      if (this.loop && this.config.dos.loopDetectionEnabled && getParser(dlpPath) !== null) {
        if (this.loop.isLooping(body)) {
          innerRes.writeHead(429, { 'Content-Type': 'application/json' })
          innerRes.end(JSON.stringify({ error: 'Agent Loop Detected' }))
          this.eventBus.emit({
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

      const result = await this.pipeline.run(
        innerReq.url ?? '/',
        body,
        { target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/' }
      )

      if (result.action === 'block') {
        innerRes.writeHead(403, { 'Content-Type': 'application/json' })
        innerRes.end(JSON.stringify({ error: 'prompt injection detected', stage: result.stage, score: result.score }))
        return
      }

      const isLlmRequest = getParser(innerReq.url ?? '/') !== null

      const bytesReceived = await this.forwardRequest(hostname, port, innerReq, bodyBuf, innerRes, isLlmRequest)
      this.eventBus.emitTraffic({
        service: identifyService(hostname),
        host: hostname,
        bytesSent: bodyBuf.length,
        bytesReceived,
      })

      // Account the INPUT (request) tokens against the budget; forwardRequest
      // additionally accounts the response tokens as they stream back.
      if (this.quota && isLlmRequest) this.quota.addTokens(this.quota.estimateTokens(body))
    }
  }

  private async forwardRequest(hostname: string, port: number, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, isLlmRequest: boolean = true): Promise<number> {
    const ip = await this.resolver.resolve(hostname)
    return new Promise<number>((resolve, reject) => {
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

      upstream.setTimeout(this.config.proxy.upstreamTimeoutMs, () => { upstream.destroy(); reject(new Error('upstream timeout')) })
      upstream.on('error', reject)

      // Parse and stream the response
      let headersDone = false
      let rawHeaders = ''
      let respBodyBytes = 0
      upstream.on('data', (chunk: Buffer) => {
        if (!headersDone) {
          rawHeaders += chunk.toString('binary')
          const sep = rawHeaders.indexOf('\r\n\r\n')
          if (sep !== -1) {
            headersDone = true
            const headerPart = rawHeaders.slice(0, sep)
            const bodyStart = rawHeaders.slice(sep + 4)
            const lines = headerPart.split('\r\n')
            const statusLine = lines[0] ?? ''
            const statusCode = parseInt(statusLine.split(' ')[1] ?? '200', 10)
            const respHeaders: Record<string, string> = {}
            for (const line of lines.slice(1)) {
              const ci = line.indexOf(': ')
              if (ci > 0) respHeaders[line.slice(0, ci).toLowerCase()] = line.slice(ci + 2)
            }
            res.writeHead(statusCode, respHeaders)
            if (bodyStart) { res.write(Buffer.from(bodyStart, 'binary')); respBodyBytes += bodyStart.length }
          }
        } else {
          res.write(chunk)
          respBodyBytes += chunk.length
        }
      })
      upstream.on('end', () => {
        res.end()
        // Account the RESPONSE size against the token budget. Runaway agents and
        // large generations rack up cost on the response side, not just input,
        // so a budget that ignored responses would badly under-count.
        if (this.quota && isLlmRequest) this.quota.addTokens(Math.ceil(respBodyBytes / 4))
        resolve(respBodyBytes)
      })
      upstream.on('error', reject)
    })
  }
}
