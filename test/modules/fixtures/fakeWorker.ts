import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { estimateTokens } from '../../../src/modules/tokens.js'

// A stand-in for the local worker of the tool result shunt: a loopback HTTP
// server that answers `POST /v1/chat/completions` the way an OpenAI-compatible
// server does, records what it was sent, and replies as a test scripts it.
// specs/001-tool-result-shunt/contracts/interfaces.md section 3 is the request
// it expects; any other method or path gets a 404.

export interface FakeWorkerReply {
  /** HTTP status; 200 by default, 307 when `location` is set. */
  status?: number
  /** Sent as the JSON body. */
  json?: unknown
  /** Sent verbatim as the body, instead of `json` (a malformed answer). */
  raw?: string
  /** Wait this long before answering (a slow worker). */
  delayMs?: number
  /** A `Location` header, for a redirect. */
  location?: string
}

export interface FakeWorkerRequest {
  headers: http.IncomingHttpHeaders
  body: unknown
}

export interface FakeWorker {
  /** Base URL, `http://127.0.0.1:<port>`: what `workerUrl` is set to. */
  url: string
  /** Every `POST /v1/chat/completions` it received, in order. */
  received: FakeWorkerRequest[]
  close(): Promise<void>
}

/** The facts of the default reply: short, and with nothing a citation check could reject. */
export const DEFAULT_FACTS = '3 tests failed. Exit code 1.'

/**
 * What a worker that read the whole request reports as `usage.prompt_tokens`:
 * the sum of `estimateTokens` over the contents of its messages. The module's
 * partial-read check (D12) therefore passes against the default reply.
 */
export function promptTokensOf(body: unknown): number {
  const messages = (body as { messages?: Array<{ content?: unknown }> } | null)?.messages ?? []
  let total = 0
  for (const m of messages) if (typeof m.content === 'string') total += estimateTokens(m.content)
  return total
}

/** A chat completion answer carrying `content`; `usage` is left out of the body when undefined. */
export function chatAnswer(content: unknown, usage?: { prompt_tokens?: number; completion_tokens?: number }): unknown {
  return {
    id: 'chatcmpl-fake',
    object: 'chat.completion',
    model: 'fake-worker-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    ...(usage ? { usage } : {}),
  }
}

function defaultAnswer(body: unknown): unknown {
  return chatAnswer(DEFAULT_FACTS, { prompt_tokens: promptTokensOf(body), completion_tokens: estimateTokens(DEFAULT_FACTS) })
}

/**
 * Start the fake worker on a free loopback port. `reply` sees the parsed
 * request body and says what to send back; with no `reply`, or a reply that
 * names no body, a 200 answer carrying DEFAULT_FACTS and a `usage` that
 * reports the whole request read is sent.
 */
export async function startFakeWorker(reply?: (body: unknown) => FakeWorkerReply | undefined): Promise<FakeWorker> {
  const received: FakeWorkerRequest[] = []
  const timers = new Set<NodeJS.Timeout>()
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/v1/chat/completions') {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{"error":"not found"}')
        return
      }
      let body: unknown
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { body = undefined }
      received.push({ headers: req.headers, body })

      const scripted = reply?.(body) ?? {}
      const status = scripted.status ?? (scripted.location ? 307 : 200)
      const send = () => {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (scripted.location) headers['location'] = scripted.location
        res.writeHead(status, headers)
        if (scripted.raw !== undefined) res.end(scripted.raw)
        else if (scripted.json !== undefined) res.end(JSON.stringify(scripted.json))
        else if (status === 200) res.end(JSON.stringify(defaultAnswer(body)))
        else res.end()
      }
      if (scripted.delayMs) {
        const timer = setTimeout(() => { timers.delete(timer); send() }, scripted.delayMs)
        timers.add(timer)
      } else {
        send()
      }
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>(resolve => {
      for (const timer of timers) clearTimeout(timer)
      timers.clear()
      server.close(() => resolve())
      server.closeAllConnections()
    }),
  }
}
