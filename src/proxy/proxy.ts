/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-misused-promises, @typescript-eslint/no-unnecessary-type-assertion */
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
import { McpScanner } from '../detection/mcp/scanner.js'
import { inspectJsonResponse, rewriteBlockedJsonResponse, createSseGate, SseGate } from '../detection/mcp/responseGate.js'
import { ChunkedDecoder } from './dechunk.js'
import { StringDecoder } from 'node:string_decoder'
import { identifyService } from '../config/providers.js'

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
  private mcp: McpScanner | null
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
    this.mcp = config.mcp?.enabled ? new McpScanner(config, this.dlp) : null
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

      let trafficEmitted = false
      const emitTunnelTraffic = () => {
        if (trafficEmitted) return
        trafficEmitted = true
        this.eventBus.emitTraffic({
          service: identifyService(hostname),
          host: hostname,
          bytesSent: upstream.bytesWritten || 0,
          bytesReceived: upstream.bytesRead || 0,
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

      // Stage 4 - MCP Request Validation. When the request exposes tools, the
      // response may carry tool_use invocations, so flag it for inbound MCP
      // inspection in forwardRequest (normal chat traffic stays on the fast path).
      let mcpInspectResponse = false
      if (this.mcp && getParser(innerReq.url ?? '/') !== null) {
        const parser = getParser(innerReq.url ?? '/')!
        const tools = parser.extractTools(body)
        if (tools.length > 0) {
          mcpInspectResponse = true
          const defResult = this.mcp.checkToolDefinitions(tools)
          if (defResult.action === 'block') {
            innerRes.writeHead(403, { 'Content-Type': 'application/json' })
            innerRes.end(JSON.stringify({ error: defResult.reason }))
            this.eventBus.emit({
              stage: 'mcp-filter',
              score: 100, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Blocked tool definition`, payload_full: JSON.stringify(tools),
              action: 'blocked', kind: 'mcp'
            })
            return
          } else {
            this.eventBus.emit({
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
            this.eventBus.emit({
              stage: 'mcp-filter',
              score: 100, similarity: 0,
              target: hostname, method: innerReq.method ?? 'GET', path: innerReq.url ?? '/',
              payload_preview: `Blocked tool result (id ${tr.toolUseId})`, payload_full: tr.result,
              action: 'blocked', kind: 'mcp'
            })
            return
          } else {
            this.eventBus.emit({
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

  // Push streamed SSE text through the MCP gate, forward the (possibly filtered)
  // result to the agent, emit audit events, and return the bytes forwarded.
  private gateSse(gate: SseGate, text: string, res: http.ServerResponse, req: http.IncomingMessage, hostname: string): number {
    const { forward, decisions } = gate.push(text)
    for (const d of decisions) {
      if (d.action === 'block') this.emitMcp('blocked', `Blocked tool invocation: ${d.toolName}`, forward, req, hostname, d.toolName)
      else this.emitMcp('passed', `Tool invoked by LLM: ${d.toolName}`, forward, req, hostname, d.toolName)
    }
    if (forward) { res.write(Buffer.from(forward, 'utf8')); return Buffer.byteLength(forward) }
    return 0
  }

  private emitMcp(action: 'blocked' | 'passed', preview: string, full: string, req: http.IncomingMessage, hostname: string, toolName?: string): void {
    this.eventBus.emit({
      stage: 'mcp-filter',
      score: action === 'blocked' ? 100 : 0,
      similarity: 0,
      target: hostname,
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      payload_preview: preview,
      payload_full: full,
      action,
      kind: 'mcp',
      ...(toolName ? { mcpTool: toolName } : {}),
    })
  }

  private async forwardRequest(hostname: string, port: number, req: http.IncomingMessage, body: Buffer, res: http.ServerResponse, isLlmRequest: boolean = true, mcpInspect: boolean = false): Promise<number> {
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

      // Parse and stream the response. When the request exposed MCP tools, the
      // response may carry tool_use invocations — inspect them BEFORE the bytes
      // reach the agent (see DESIGN-mcp-response.md): non-streaming JSON is
      // buffered and rewritten tool-free; streaming SSE is gated per tool block.
      // Everything else streams straight through untouched.
      const parser = getParser(req.url ?? '/')
      const mcpEnabled = !!(this.mcp && mcpInspect && parser)
      const maxResp = this.config.proxy.maxBodyBytes

      let headersDone = false
      let rawHeaders = ''
      let respBodyBytes = 0
      // 'json' buffers the whole body for inspection; 'json-stream' is the
      // fail-open fallback once an oversized body forces us to start flushing.
      let mode: 'passthrough' | 'json' | 'json-stream' | 'sse' = 'passthrough'
      let status = 200
      const respHeaders: Record<string, string> = {}
      let jsonBuf = ''
      let gate: SseGate | null = null
      let dechunker: ChunkedDecoder | null = null
      const decoder = new StringDecoder('utf8')
      // Inspected modes operate on the decoded payload, so strip the framing
      // headers and let Node re-frame whatever we forward.
      const inspectedHeaders = (): Record<string, string> => {
        const h = { ...respHeaders }
        delete h['content-length']
        delete h['transfer-encoding']
        return h
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

          const ctype = (respHeaders['content-type'] ?? '').toLowerCase()
          if (mcpEnabled && ctype.includes('text/event-stream')) mode = 'sse'
          else if (mcpEnabled && ctype.includes('application/json')) mode = 'json'

          // Inspected modes need the decoded payload, not the chunk framing.
          if (mode !== 'passthrough' && (respHeaders['transfer-encoding'] ?? '').toLowerCase().includes('chunked')) {
            dechunker = new ChunkedDecoder()
          }
          const payload = (raw: Buffer): string => decoder.write(dechunker ? dechunker.push(raw) : raw)

          if (mode === 'sse') {
            gate = createSseGate(parser!, this.mcp!)
            res.writeHead(status, inspectedHeaders())
            respBodyBytes += this.gateSse(gate, payload(bodyStart), res, req, hostname)
          } else if (mode === 'json') {
            jsonBuf += payload(bodyStart) // withhold: we may rewrite it on end
          } else {
            res.writeHead(status, respHeaders)
            if (bodyStart.length) { res.write(bodyStart); respBodyBytes += bodyStart.length }
          }
        } else if (mode === 'sse' && gate) {
          respBodyBytes += this.gateSse(gate, decoder.write(dechunker ? dechunker.push(chunk) : chunk), res, req, hostname)
        } else if (mode === 'json') {
          jsonBuf += decoder.write(dechunker ? dechunker.push(chunk) : chunk)
          if (jsonBuf.length > maxResp) {
            // Oversized — fail open: emit a warning, flush what we have, and
            // stream the decoded remainder without inspection.
            this.emitMcp('passed', `Response too large to inspect (${jsonBuf.length}B)`, '', req, hostname)
            res.writeHead(status, inspectedHeaders())
            res.write(Buffer.from(jsonBuf, 'utf8'))
            respBodyBytes += Buffer.byteLength(jsonBuf)
            jsonBuf = ''
            mode = 'json-stream'
          }
        } else if (mode === 'json-stream') {
          const text = decoder.write(dechunker ? dechunker.push(chunk) : chunk)
          if (text) { res.write(Buffer.from(text, 'utf8')); respBodyBytes += Buffer.byteLength(text) }
        } else {
          res.write(chunk)
          respBodyBytes += chunk.length
        }
      })
      upstream.on('end', () => {
        if (mode === 'json' && this.mcp && parser) {
          jsonBuf += decoder.end()
          const { decisions, blockedNames } = inspectJsonResponse(jsonBuf, parser, this.mcp)
          for (const d of decisions) {
            if (d.action === 'block') this.emitMcp('blocked', `Blocked tool invocation: ${d.toolName}`, jsonBuf, req, hostname, d.toolName)
            else this.emitMcp('passed', `Tool invoked by LLM: ${d.toolName}`, jsonBuf, req, hostname, d.toolName)
          }
          const finalBody = blockedNames.size > 0 ? rewriteBlockedJsonResponse(jsonBuf, blockedNames) : jsonBuf
          res.writeHead(status, inspectedHeaders())
          res.end(Buffer.from(finalBody, 'utf8'))
          respBodyBytes = Buffer.byteLength(finalBody)
        } else {
          if (mode === 'sse' && gate) {
            const tail = gate.flush()
            if (tail) { res.write(tail); respBodyBytes += Buffer.byteLength(tail) }
          }
          res.end()
        }
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
