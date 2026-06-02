import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import https from 'node:https'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import forge from 'node-forge'
import { ProxyServer } from '../../src/proxy/proxy.js'
import { EventBus } from '../../src/dashboard/eventBus.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { UpstreamResolver } from '../../src/proxy/upstream.js'
import { CertFactory } from '../../src/proxy/certs.js'
import type { BlockEvent } from '../../src/types.js'

vi.spyOn(UpstreamResolver.prototype, 'resolve').mockResolvedValue('127.0.0.1')

function generateSelfSignedCert() {
  const keys = forge.pki.rsa.generateKeyPair(2048)
  const cert = forge.pki.createCertificate()
  cert.publicKey = keys.publicKey
  cert.serialNumber = '01'
  cert.validity.notBefore = new Date()
  cert.validity.notAfter = new Date()
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1)
  const attrs = [{ name: 'commonName', value: 'api.anthropic.com' }]
  cert.setSubject(attrs)
  cert.setIssuer(attrs)
  cert.sign(keys.privateKey)
  return { key: forge.pki.privateKeyToPem(keys.privateKey), cert: forge.pki.certificateToPem(cert) }
}

function dechunkBody(body: string): string {
  let result = ''
  let pos = 0
  while (pos < body.length) {
    const nextLineSep = body.indexOf('\r\n', pos)
    if (nextLineSep === -1) break
    const size = parseInt(body.slice(pos, nextLineSep).trim(), 16)
    if (isNaN(size) || size === 0) break
    const chunkStart = nextLineSep + 2
    result += body.slice(chunkStart, chunkStart + size)
    pos = chunkStart + size + 2
  }
  return result
}

interface ClientResponse { statusCode: number; headers: Record<string, string>; body: string }

async function sendProxyRequest(
  proxyPort: number, targetHost: string, targetPort: number,
  method: string, path: string, headers: Record<string, string>, body: string,
): Promise<ClientResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: proxyPort }, () => {
      socket.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`)
    })
    let buffer = ''
    socket.on('error', reject)
    socket.on('data', function onConnectData(chunk: Buffer) {
      buffer += chunk.toString('binary')
      const sep = buffer.indexOf('\r\n\r\n')
      if (sep === -1) return
      socket.removeListener('data', onConnectData)
      if (!buffer.slice(0, buffer.indexOf('\r\n')).includes('200')) {
        reject(new Error('CONNECT failed'))
        socket.destroy()
        return
      }
      const tlsSocket = tls.connect({ socket, servername: targetHost, rejectUnauthorized: false }, () => {
        tlsSocket.write(`${method} ${path} HTTP/1.1\r\n`)
        const reqHeaders = { ...headers, Host: targetHost, 'Content-Length': Buffer.byteLength(body).toString(), Connection: 'close' }
        for (const [k, v] of Object.entries(reqHeaders)) tlsSocket.write(`${k}: ${v}\r\n`)
        tlsSocket.write('\r\n')
        if (body) tlsSocket.write(body)
      })
      let resData = ''
      tlsSocket.on('data', (d) => { resData += d.toString('binary') })
      tlsSocket.on('end', () => {
        const headerSep = resData.indexOf('\r\n\r\n')
        if (headerSep === -1) { reject(new Error('Invalid HTTP response')); return }
        const lines = resData.slice(0, headerSep).split('\r\n')
        const statusCode = parseInt((lines[0] ?? '').split(' ')[1] ?? '200', 10)
        const respHeaders: Record<string, string> = {}
        for (const line of lines.slice(1)) {
          const ci = line.indexOf(': ')
          if (ci > 0) respHeaders[line.slice(0, ci).toLowerCase()] = line.slice(ci + 2)
        }
        let responseBody = resData.slice(headerSep + 4)
        if (respHeaders['transfer-encoding'] === 'chunked') responseBody = dechunkBody(responseBody)
        resolve({ statusCode, headers: respHeaders, body: responseBody })
      })
      tlsSocket.on('error', reject)
    })
  })
}

// Anthropic SSE event helper.
function sse(type: string, obj: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...obj })}\n\n`
}

describe('Proxy MCP interception (E2E)', { timeout: 20000 }, () => {
  let tempDir: string
  let mockUpstream: https.Server
  let mockUpstreamPort: number
  let upstreamHits = 0
  let proxy: ProxyServer
  let eventBus: EventBus

  const testConfig = {
    ...DEFAULT_CONFIG,
    proxy: { ...DEFAULT_CONFIG.proxy, port: 18090 },
    dashboard: { ...DEFAULT_CONFIG.dashboard, port: 17790 },
  }

  // A request that exposes an allowed tool (so the response is inspected) and
  // selects an upstream scenario.
  function toolRequest(scenario: string): string {
    return JSON.stringify({
      model: 'claude-3-haiku-20240307',
      max_tokens: 100,
      scenario,
      tools: [{ name: 'get_weather', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'what is the weather in Paris?' }],
    })
  }

  beforeAll(async () => {
    tempDir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-mcp-e2e-'))
    process.env.LLM_FW_DIR = tempDir
    new CertFactory().generateCA()
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const certs = generateSelfSignedCert()
    mockUpstream = https.createServer(certs, (req, res) => {
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', () => {
        upstreamHits++
        let scenario = 'plain'
        try { scenario = (JSON.parse(body) as { scenario?: string }).scenario ?? 'plain' } catch { /* ignore */ }

        if (scenario === 'json-blocked') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_1', type: 'message', role: 'assistant', stop_reason: 'tool_use',
            content: [
              { type: 'text', text: 'Checking.' },
              { type: 'tool_use', id: 'toolu_a', name: 'execute_command', input: { cmd: 'rm -rf /' } },
              { type: 'tool_use', id: 'toolu_b', name: 'get_weather', input: { city: 'Paris' } },
            ],
          }))
        } else if (scenario === 'json-allowed') {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({
            id: 'msg_2', type: 'message', role: 'assistant', stop_reason: 'tool_use',
            content: [{ type: 'tool_use', id: 'toolu_c', name: 'get_weather', input: { city: 'Paris' } }],
          }))
        } else if (scenario === 'sse-blocked') {
          res.writeHead(200, { 'Content-Type': 'text/event-stream' })
          res.write(sse('message_start', { message: { id: 'msg_3', role: 'assistant' } }))
          res.write(sse('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }))
          res.write(sse('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Let me check.' } }))
          res.write(sse('content_block_stop', { index: 0 }))
          res.write(sse('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'toolu_d', name: 'execute_command', input: {} } }))
          res.write(sse('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' } }))
          res.write(sse('content_block_stop', { index: 1 }))
          res.write(sse('message_delta', { delta: { stop_reason: 'tool_use' } }))
          res.end(sse('message_stop', {}))
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'hi' }] }))
        }
      })
    })
    await new Promise<void>((r) => mockUpstream.listen(0, '127.0.0.1', () => r()))
    mockUpstreamPort = (mockUpstream.address() as net.AddressInfo).port

    eventBus = new EventBus(testConfig.dashboard)
    proxy = new ProxyServer(testConfig, eventBus)
    await proxy.init()
    proxy.start()
  })

  afterAll(async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1'
    await proxy.stop()
    await new Promise<void>((r) => mockUpstream.close(() => r()))
    if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const send = (path: string, body: string) =>
    sendProxyRequest(testConfig.proxy.port, 'api.anthropic.com', mockUpstreamPort, 'POST', path, { 'Content-Type': 'application/json' }, body)

  function mcpEvents(): BlockEvent[] {
    return eventBus.getAll().filter((e) => e.stage === 'mcp-filter')
  }

  it('blocks an unauthorized tool DEFINITION at the request boundary (403, no upstream hit)', async () => {
    const before = upstreamHits
    const res = await send('/v1/messages', JSON.stringify({
      model: 'claude-3-haiku-20240307', max_tokens: 16,
      tools: [{ name: 'execute_command', input_schema: { type: 'object', properties: {} } }],
      messages: [{ role: 'user', content: 'hi' }],
    }))
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body).error).toContain('blocked by policy')
    expect(upstreamHits).toBe(before) // request never forwarded
    expect(mcpEvents().some((e) => e.action === 'blocked' && e.payload_preview.includes('tool definition'))).toBe(true)
  })

  it('strips a blocked tool_use from a non-streaming JSON response, keeping allowed ones', async () => {
    const res = await send('/v1/messages', toolRequest('json-blocked'))
    expect(res.statusCode).toBe(200)
    const json = JSON.parse(res.body) as { content: Array<{ type: string; name?: string }>; stop_reason: string }
    const toolNames = json.content.filter((b) => b.type === 'tool_use').map((b) => b.name)
    expect(toolNames).toContain('get_weather')      // allowed invocation survives
    expect(toolNames).not.toContain('execute_command') // blocked invocation stripped
    // The blocked name only survives inside the human-readable policy note, never as a tool_use.
    expect(json.content.some((b) => b.type === 'text' && (b as { text: string }).text.includes('blocked'))).toBe(true)
    expect(json.stop_reason).toBe('tool_use') // an allowed tool remains
    expect(mcpEvents().some((e) => e.action === 'blocked' && e.mcpTool === 'execute_command')).toBe(true)
  })

  it('passes an allowed tool_use through a JSON response untouched', async () => {
    const res = await send('/v1/messages', toolRequest('json-allowed'))
    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('get_weather')
    expect(mcpEvents().some((e) => e.action === 'passed' && e.mcpTool === 'get_weather')).toBe(true)
  })

  it('gates a blocked tool_use out of a streaming SSE response', async () => {
    const res = await send('/v1/messages', toolRequest('sse-blocked'))
    expect(res.statusCode).toBe(200)
    // The text block streams through…
    expect(res.body).toContain('Let me check.')
    // …but the blocked tool block and its argument deltas are gone…
    expect(res.body).not.toContain('execute_command')
    expect(res.body).not.toContain('input_json_delta')
    // …and the terminating stop_reason is downgraded so the agent ends cleanly.
    expect(res.body).toContain('"stop_reason":"end_turn"')
    expect(res.body).not.toContain('"stop_reason":"tool_use"')
    expect(mcpEvents().some((e) => e.action === 'blocked' && e.mcpTool === 'execute_command')).toBe(true)
  })
})
