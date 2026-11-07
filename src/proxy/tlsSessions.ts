import tls from 'node:tls'

/**
 * The last TLS session per upstream host and port, offered on the next
 * connection so it resumes instead of running a full handshake (#670).
 * Measured 2026-11-07, the handshake was 34-41 ms of each request's 50-55 ms
 * of connection setup to the providers. The upstream leg still opens one
 * connection per request and reads it until it closes; only the handshake
 * changes, so response framing, streaming and the scans are untouched.
 *
 * A session is only ever offered back to the server name it came from, and
 * Node verifies the server's certificate on a resumed connection as on a
 * full one.
 */
export class TlsSessionCache {
  private readonly sessions = new Map<string, Buffer>()

  constructor(private readonly maxHosts = 256) {}

  get size(): number { return this.sessions.size }

  get(servername: string, port: number): Buffer | undefined {
    return this.sessions.get(`${servername}:${port}`)
  }

  set(servername: string, port: number, session: Buffer): void {
    const key = `${servername}:${port}`
    this.sessions.delete(key)
    this.sessions.set(key, session)
    if (this.sessions.size > this.maxHosts) this.sessions.delete(this.sessions.keys().next().value!)
  }

  forget(servername: string, port: number): void {
    this.sessions.delete(`${servername}:${port}`)
  }

  /**
   * tls.connect with the host's last session offered, keeping the newest
   * session the server issues and dropping the host's session when the
   * connection fails, so a session the server no longer accepts is not
   * offered again.
   */
  connect(options: tls.ConnectionOptions & { servername: string; port: number }, onConnect?: () => void): tls.TLSSocket {
    const { servername, port } = options
    const session = this.get(servername, port)
    const socket = tls.connect(session ? { ...options, session } : options, onConnect)
    socket.on('session', (s: Buffer) => this.set(servername, port, s))
    socket.on('error', () => this.forget(servername, port))
    return socket
  }
}
