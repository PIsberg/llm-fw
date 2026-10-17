import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { tapResponse, type CapturedResponse } from '../../src/modules/responseTap.js'

// Serves one request with `handler`, which writes through a tapped response,
// and resolves with what the tap captured once the response has finished.
async function capture(maxBytes: number, handler: (res: http.ServerResponse) => void): Promise<CapturedResponse | null> {
  let result: Promise<CapturedResponse | null> = Promise.resolve(null)
  const server = http.createServer((_req, res) => {
    const done = tapResponse(res, maxBytes)
    result = new Promise(resolve => res.on('finish', () => resolve(done())))
    handler(res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port }, res => { res.resume(); res.on('end', resolve) }).on('error', reject)
  })
  server.close()
  return result
}

describe('tapResponse', () => {
  it('captures status, headers and every written chunk', async () => {
    const got = await capture(1024, res => {
      res.setHeader('x-request-id', 'r1')
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.write('ab')
      res.write(Buffer.from('cd'))
      res.end('ef')
    })
    expect(got?.status).toBe(201)
    expect(got?.headers['content-type']).toBe('application/json')
    expect(got?.headers['x-request-id']).toBe('r1')
    expect(got?.body.toString()).toBe('abcdef')
  })

  it('accepts a status message and a raw header array', async () => {
    const got = await capture(1024, res => {
      res.writeHead(200, 'OK', ['Content-Type', 'text/event-stream'])
      res.end()
    })
    expect(got?.headers['content-type']).toBe('text/event-stream')
    expect(got?.body.length).toBe(0)
  })

  it('gives up on a body larger than the cap rather than buffering it', async () => {
    const got = await capture(3, res => {
      res.writeHead(200)
      res.end('abcd')
    })
    expect(got).toBeNull()
  })

  it('still delivers every byte to the client', async () => {
    let received = ''
    const server = http.createServer((_req, res) => {
      tapResponse(res, 2)
      res.writeHead(200)
      res.write('hello ')
      res.end('world')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    await new Promise<void>(resolve => {
      http.get({ host: '127.0.0.1', port }, res => { res.on('data', c => { received += c }); res.on('end', resolve) })
    })
    server.close()
    expect(received).toBe('hello world')
  })
})
