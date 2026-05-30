import http from 'node:http'
import https from 'node:https'
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
  // Keep-alive agent: reuses TCP/TLS connections to upstream APIs instead of
  // opening a fresh TLS handshake per request (was the raw tls.connect approach).
  private agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000 })

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
          for await (const chunk of innerReq) chunks.push(Buffer.from(chunk))
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

  private async forwardRequest(
    hostname: string,
    port: number,
    req: http.IncomingMessage,
    body: string,
    res: http.ServerResponse,
  ): Promise<void> {
    const ip = await this.resolver.resolve(hostname)
    await new Promise<void>((resolve, reject) => {
      const upstreamReq = https.request(
        {
          hostname: ip,
          port,
          path: req.url ?? '/',
          method: req.method ?? 'GET',
          // Preserve all original headers; override Host so upstream sees the right virtual host.
          headers: { ...req.headers, host: hostname },
          agent: this.agent, // connection reuse via Keep-Alive
          servername: hostname, // SNI for TLS
          timeout: this.config.proxy.upstreamTimeoutMs,
        },
        (upstreamRes) => {
          // Let Node handle header deduplication, chunked encoding, and compression.
          res.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers)
          upstreamRes.pipe(res)
          upstreamRes.on('end', resolve)
          upstreamRes.on('error', reject)
        },
      )
      upstreamReq.on('error', reject)
      upstreamReq.on('timeout', () => {
        upstreamReq.destroy()
        reject(new Error('upstream timeout'))
      })
      if (body) upstreamReq.write(body)
      upstreamReq.end()
    })
  }
}
