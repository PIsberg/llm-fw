import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Config } from '../types.js'
import { CertFactory } from './certs.js'
import { UpstreamResolver } from './upstream.js'
import { Pipeline } from '../detection/pipeline.js'
import { EventBus } from '../dashboard/eventBus.js'

export class ProxyServer {
  private server: http.Server
  private certFactory: CertFactory
  private resolver: UpstreamResolver
  private pipeline: Pipeline
  private config: Config

  constructor(config: Config, eventBus: EventBus) {
    this.config = config
    this.certFactory = new CertFactory()
    this.resolver = new UpstreamResolver(config.proxy)
    this.pipeline = new Pipeline(config, partial => eventBus.emit(partial))
    this.server = http.createServer()
  }

  async init(): Promise<void> { await this.pipeline.init() }

  start(): void {
    this.server.on('connect', (req, socket, head) => {
      void this.handleConnect(req, socket as net.Socket, head)
    })
    this.server.listen(this.config.proxy.port)
  }

  stop(): Promise<void> {
    return new Promise(resolve => this.server.close(() => resolve()))
  }

  private async handleConnect(req: http.IncomingMessage, clientSocket: net.Socket, _head: Buffer): Promise<void> {
    const url = req.url ?? ''
    const colonIdx = url.lastIndexOf(':')
    const hostname = url.slice(0, colonIdx)
    const port = parseInt(url.slice(colonIdx + 1), 10) || 443

    const isTarget = this.config.targets.some(t => hostname === t || hostname.endsWith('.' + t))

    if (!isTarget) {
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
        try {
          const chunks: Buffer[] = []
          let accumulatedBody = ''
          let blocked = false

          // Intercept request stream to check chunks on the fly
          innerReq.on('data', (chunk) => {
            if (blocked) return
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
            }).catch(() => {})
          })

          await new Promise<void>((resolve, reject) => {
            innerReq.on('end', () => resolve())
            innerReq.on('error', (err) => reject(err))
          })

          if (blocked) return

          const body = Buffer.concat(chunks).toString('utf-8')

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

          await this.forwardRequest(hostname, port, innerReq, body, innerRes)
        } catch (err) {
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

  private async forwardRequest(hostname: string, port: number, req: http.IncomingMessage, body: string, res: http.ServerResponse): Promise<void> {
    const ip = await this.resolver.resolve(hostname)
    await new Promise<void>((resolve, reject) => {
      const upstream = tls.connect({ host: ip, port, servername: hostname }, () => {
        upstream.write(req.method + ' ' + (req.url ?? '/') + ' HTTP/1.1\r\n')
        const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-connection', 'proxy-authorization', 'proxy-authenticate', 'content-length', 'accept-encoding'])
        const headers = { ...req.headers, host: hostname }
        for (const [k, v] of Object.entries(headers)) {
          if (v && !HOP_BY_HOP.has(k.toLowerCase())) upstream.write(k + ': ' + (Array.isArray(v) ? v.join(', ') : v) + '\r\n')
        }
        upstream.write('Content-Length: ' + Buffer.byteLength(body) + '\r\n')
        upstream.write('Accept-Encoding: identity\r\n')
        upstream.write('Connection: close\r\n')
        upstream.write('\r\n')
        if (body) upstream.write(body)
      })

      upstream.setTimeout(this.config.proxy.upstreamTimeoutMs, () => { upstream.destroy(); reject(new Error('upstream timeout')) })
      upstream.on('error', reject)

      // Parse and stream the response
      let headersDone = false
      let rawHeaders = ''
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
            if (bodyStart) res.write(Buffer.from(bodyStart, 'binary'))
          }
        } else {
          res.write(chunk)
        }
      })
      upstream.on('end', () => { res.end(); resolve() })
      upstream.on('error', reject)
    })
  }
}
