import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import zlib from 'node:zlib'
import { stripUsageChunk } from '../../src/modules/sseUsageStrip.js'
import { tapResponse } from '../../src/modules/responseTap.js'

// #421: with the stream usage reporter on, a provider sends one more chunk
// (empty `choices`, a `usage` object) that the client never asked for, and
// client code that reads `choices[0]` unchecked throws on it (measured for
// #414 with openai-node and openai-python). The filter drops that chunk from
// what the client receives, after the response tap has seen it.

const base = { id: 'chatcmpl-1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test' }
const event = (choices: unknown[], usage: unknown) => `data: ${JSON.stringify({ ...base, choices, usage })}\n\n`
const CONTENT = event([{ index: 0, delta: { content: 'Hello' }, finish_reason: null }], null)
const STOP = event([{ index: 0, delta: {}, finish_reason: 'stop' }], null)
const USAGE = event([], { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 })
const DONE = 'data: [DONE]\n\n'

let server: http.Server | undefined
afterEach(() => new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve())))

/** Serves one response through the filter (and a tap, installed after it, as the listeners do). */
async function serve(write: (res: http.ServerResponse) => void, filter = true): Promise<{ body: string; raw: Buffer; tapped: string }> {
  let tapped = ''
  server = http.createServer((_req, res) => {
    if (filter) stripUsageChunk(res)
    const captured = tapResponse(res, 1 << 20)
    res.on('finish', () => { tapped = captured()?.body.toString() ?? '' })
    write(res)
  })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as { port: number }).port
  const raw = await new Promise<Buffer>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/' }, res => {
      const chunks: Buffer[] = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    }).on('error', reject)
  })
  await new Promise(resolve => setImmediate(resolve))
  return { body: raw.toString(), raw, tapped }
}

describe('stripUsageChunk', () => {
  it('drops the usage-only chunk and keeps every other event, in order', async () => {
    const { body } = await serve(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(CONTENT)
      res.write(STOP)
      res.write(USAGE)
      res.end(DONE)
    })
    expect(body).toBe(CONTENT + STOP + DONE)
  })

  it('finds the chunk across write boundaries and CRLF framing', async () => {
    const crlf = (e: string) => e.replace(/\n/g, '\r\n')
    const stream = crlf(CONTENT) + crlf(USAGE) + crlf(DONE)
    const { body } = await serve(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
      const cut = stream.indexOf('usage') + 3
      res.write(stream.slice(0, 7))
      res.write(stream.slice(7, cut))
      res.end(stream.slice(cut))
    })
    expect(body).toBe(crlf(CONTENT) + crlf(DONE))
  })

  it('lets the response tap still see the chunk', async () => {
    const { body, tapped } = await serve(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(CONTENT + USAGE + DONE)
    })
    expect(body).not.toContain('"usage":{')
    expect(tapped).toContain('"prompt_tokens":9')
  })

  it('leaves a response it cannot read as plain events alone', async () => {
    const gz = zlib.gzipSync(CONTENT + USAGE + DONE)
    const compressed = await serve(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })
      res.end(gz)
    })
    expect(compressed.raw.equals(gz)).toBe(true)
    const json = await serve(res => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }))
    })
    expect(json.body).toBe(JSON.stringify({ choices: [], usage: { total_tokens: 1 } }))
  })

  it('keeps a chunk that carries choices as well as usage', async () => {
    const both = event([{ index: 0, delta: { content: 'x' }, finish_reason: 'stop' }], { total_tokens: 3 })
    const { body } = await serve(res => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end(both + DONE)
    })
    expect(body).toBe(both + DONE)
  })
})
