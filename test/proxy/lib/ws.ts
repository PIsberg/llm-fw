import crypto from 'node:crypto'
import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { encodeFrame, FrameReader, OPCODE } from '../../../src/proxy/websocket.js'

/**
 * WebSocket helpers for the relay E2E suites (#270, #344): a client session
 * over any connected socket, and a stand-in provider that records what it
 * receives. proxy-realtime.e2e.test.ts predates these and keeps its own copy.
 */

export interface WsSession {
  /** Send one JSON event in a masked text frame. */
  send(event: Record<string, unknown>): void
  /** Server-to-client text events, parsed. */
  received: Record<string, unknown>[]
  closeCode: () => number | null
  closeReason: () => string
  closed: Promise<void>
  socket: Duplex
}

/** WebSocket handshake on `sock`; resolves with the response head and the session. */
export function wsHandshake(
  sock: Duplex,
  path: string,
  host: string,
  headers: Record<string, string> = {},
): Promise<{ status: string; head: string; body: string; session: WsSession }> {
  return new Promise(resolve => {
    const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')
    sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n${extra}\r\n`)
    let buf = Buffer.alloc(0)
    const received: Record<string, unknown>[] = []
    let closeCode: number | null = null
    let closeReason = ''
    let done!: () => void
    const closed = new Promise<void>(r => { done = r })
    const reader = new FrameReader()
    const onFrames = (b: Buffer): void => {
      for (const f of reader.push(b)) {
        if (f.opcode === OPCODE.text) received.push(JSON.parse(f.payload.toString()))
        if (f.opcode === OPCODE.close) {
          closeCode = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005
          closeReason = f.payload.subarray(2).toString()
        }
      }
    }
    const onData = (c: Buffer): void => {
      buf = Buffer.concat([buf, c])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buf.subarray(0, end).toString()
      const status = head.slice(0, head.indexOf('\r\n') < 0 ? head.length : head.indexOf('\r\n'))
      const rest = buf.subarray(end + 4)
      const session: WsSession = {
        send: e => sock.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(e)), true)),
        received,
        closeCode: () => closeCode,
        closeReason: () => closeReason,
        closed,
        socket: sock,
      }
      if (status.includes('101')) {
        sock.off('data', onData)
        if (rest.length) onFrames(rest)
        sock.on('data', onFrames)
        resolve({ status, head, body: '', session })
        return
      }
      // Not upgraded: an HTTP answer with a Content-Length body.
      const len = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
      if (rest.length < len) return
      sock.off('data', onData)
      resolve({ status, head, body: rest.subarray(0, len).toString(), session })
    }
    sock.on('data', onData)
    sock.on('close', () => done())
    sock.on('end', () => done())
    sock.on('error', () => done())
  })
}

export interface FakeWsUpstream {
  /** Every client event received, per connection, newest connection last. */
  got: Record<string, unknown>[][]
  /** The handshake request of each connection. */
  requests: { url: string; headers: http.IncomingHttpHeaders }[]
  /** End every upgraded socket. `server.closeAllConnections()` does not reach them, and `close()` waits for them. */
  destroyAll(): void
}

/**
 * Make `server` a minimal WebSocket provider: accept every upgrade, send
 * `greeting`, record each client JSON event (text or binary frame).
 */
export function fakeWsUpstream(server: http.Server, greeting: Record<string, unknown>): FakeWsUpstream {
  const sockets = new Set<Duplex>()
  const state: FakeWsUpstream = { got: [], requests: [], destroyAll: () => { for (const s of sockets) s.destroy() } }
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    state.requests.push({ url: req.url ?? '', headers: req.headers })
    const accept = crypto.createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    socket.write(encodeFrame(OPCODE.text, Buffer.from(JSON.stringify(greeting)), false))
    const got: Record<string, unknown>[] = []
    state.got.push(got)
    const reader = new FrameReader()
    socket.on('data', (c: Buffer) => {
      for (const f of reader.push(c)) {
        if (f.opcode === OPCODE.text || f.opcode === OPCODE.binary) {
          try { got.push(JSON.parse(f.payload.toString())) } catch { got.push({ unparsed: f.payload.toString() }) }
        }
        if (f.opcode === OPCODE.close) socket.end()
      }
    })
    socket.on('error', () => {})
  })
  return state
}

export async function waitFor(pred: () => boolean, ms = 30_000): Promise<void> {
  const t = Date.now() + ms
  while (Date.now() < t) { if (pred()) return; await new Promise(r => setTimeout(r, 25)) }
  throw new Error('timed out')
}
