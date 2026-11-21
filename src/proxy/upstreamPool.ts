import type tls from 'node:tls'

/**
 * Idle upstream TLS connections, kept for the next request to the same
 * provider (#670, `proxy.upstreamKeepAlive`). A new connection costs a TCP
 * and a TLS round trip, about 50 ms to the providers measured 2026-11-07; a
 * kept one costs nothing.
 *
 * A connection goes back only once its response was read to the end of its
 * framing, with nothing after it (proxy.ts decides that). While idle it is
 * watched: any byte or error from it, or ending, removes and destroys it, so a
 * connection the provider closed is never handed out. It is closed after
 * `idleMs`; the providers kept an idle connection open for 240 s on
 * 2026-11-21, so 30 s leaves a wide margin. Keyed by server name, port and the
 * resolved address, so a connection is only reused for the host it was
 * verified for.
 */
export class UpstreamPool {
  private readonly idle = new Map<string, tls.TLSSocket[]>()
  private readonly watchers = new WeakMap<tls.TLSSocket, { timer: NodeJS.Timeout; drop: () => void }>()

  constructor(private readonly idleMs = 30_000, private readonly maxPerKey = 8) {}

  /** Connections waiting, over every key. */
  get size(): number {
    let n = 0
    for (const list of this.idle.values()) n += list.length
    return n
  }

  /** The most recently used live connection for `key`, no longer watched; null when there is none. */
  take(key: string): tls.TLSSocket | null {
    const list = this.idle.get(key)
    while (list && list.length > 0) {
      const socket = list.pop()!
      this.unwatch(socket)
      if (socket.destroyed || !socket.readable || !socket.writable) { socket.destroy(); continue }
      if (list.length === 0) this.idle.delete(key)
      socket.ref()
      return socket
    }
    this.idle.delete(key)
    return null
  }

  /** Keep `socket` for `key`. The caller has removed its own listeners. */
  put(key: string, socket: tls.TLSSocket): void {
    if (socket.destroyed || !socket.readable || !socket.writable) { socket.destroy(); return }
    const list = this.idle.get(key) ?? []
    if (list.length >= this.maxPerKey) { socket.destroy(); return }
    const drop = (): void => {
      this.unwatch(socket)
      const at = list.indexOf(socket)
      if (at !== -1) list.splice(at, 1)
      if (list.length === 0 && this.idle.get(key) === list) this.idle.delete(key)
      socket.destroy()
    }
    const timer = setTimeout(drop, this.idleMs)
    timer.unref()
    socket.on('data', drop)
    socket.on('end', drop)
    socket.on('close', drop)
    socket.on('error', drop)
    socket.unref()
    this.watchers.set(socket, { timer, drop })
    list.push(socket)
    this.idle.set(key, list)
  }

  /** Destroy every idle connection (the proxy is stopping). */
  close(): void {
    // A copy: drop() takes each socket out of the list being walked.
    const all = Array.from(this.idle.values()).flat()
    for (const socket of all) this.watchers.get(socket)?.drop()
    this.idle.clear()
  }

  private unwatch(socket: tls.TLSSocket): void {
    const w = this.watchers.get(socket)
    if (!w) return
    clearTimeout(w.timer)
    socket.removeListener('data', w.drop)
    socket.removeListener('end', w.drop)
    socket.removeListener('close', w.drop)
    socket.removeListener('error', w.drop)
    this.watchers.delete(socket)
  }
}
