/**
 * Incremental HTTP/1.1 chunked-transfer decoder.
 *
 * Upstream LLM responses — especially streaming SSE — use
 * `Transfer-Encoding: chunked`, so the raw bytes after the headers carry chunk
 * framing (hex size lines + CRLFs). MCP response inspection needs the actual
 * payload, so feed raw body bytes here as they arrive and get back the decoded
 * payload. Chunk boundaries may land anywhere; chunk extensions and trailers
 * are ignored. The passthrough path uses this too: it decodes the upstream
 * framing so Node can re-frame the response exactly once. Forwarding the raw
 * chunk framing instead would double-frame it (the hex size lines leak into the
 * body the client sees), so this decode is required, not optional.
 */
// A chunk size: hex digits only (#868). parseInt read "-5" as -5 and "10xyz"
// as 16. Fifteen digits is past any body and still an exact number.
const CHUNK_SIZE = /^[0-9a-fA-F]{1,15}$/

export class ChunkedDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private need = 0          // bytes left in the current chunk's data
  private afterData = false // expecting the CRLF that terminates chunk data
  /** The zero-length chunk has been read: the payload is all here. */
  finished = false
  /**
   * The trailer section after it has ended too, so the whole message is read
   * and a kept-alive connection could carry the next one (#670).
   */
  complete = false
  /** Bytes received after the message ended; a connection with any is not reused. */
  excess = 0
  /** A size line that was not hex: never complete, so the connection is not reused. */
  private malformed = false

  push(raw: Buffer): Buffer {
    if (this.complete) { this.excess += raw.length; return Buffer.alloc(0) }
    // Nothing after malformed framing is read, so none of it is kept (#868):
    // each push copied all that had come before it.
    if (this.malformed) return Buffer.alloc(0)
    this.buf = this.buf.length ? Buffer.concat([this.buf, raw]) : raw
    if (this.finished) {
      if (!this.malformed) this.readTrailers()
      return Buffer.alloc(0)
    }
    const out: Buffer[] = []
    for (;;) {
      if (this.afterData) {
        if (this.buf.length < 2) break
        // Chunk data ends with CRLF; anything else is malformed framing, never
        // a complete message a kept connection could carry on from (#868).
        if (this.buf[0] !== 0x0d || this.buf[1] !== 0x0a) { this.fail(); break }
        this.buf = this.buf.subarray(2)
        this.afterData = false
        continue
      }
      if (this.need > 0) {
        if (this.buf.length === 0) break
        const take = Math.min(this.need, this.buf.length)
        out.push(this.buf.subarray(0, take))
        this.buf = this.buf.subarray(take)
        this.need -= take
        if (this.need === 0) this.afterData = true
        continue
      }
      // Read the next chunk-size line.
      const idx = this.buf.indexOf('\r\n')
      if (idx === -1) break
      const sizeHex = (this.buf.subarray(0, idx).toString('ascii').split(';')[0] ?? '').trim()
      if (!CHUNK_SIZE.test(sizeHex)) { this.fail(); break }
      const size = parseInt(sizeHex, 16)
      this.buf = this.buf.subarray(idx + 2)
      if (size === 0) { this.finished = true; this.readTrailers(); break }
      this.need = size
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0)
  }

  /** Malformed framing: the payload ends here, the message is never complete, and nothing more is kept. */
  private fail(): void {
    this.finished = true
    this.malformed = true
    this.buf = Buffer.alloc(0)
  }

  /** Skip trailer lines up to the empty line that ends the message. */
  private readTrailers(): void {
    for (;;) {
      const idx = this.buf.indexOf('\r\n')
      if (idx === -1) return
      this.buf = this.buf.subarray(idx + 2)
      if (idx === 0) {
        this.complete = true
        this.excess = this.buf.length
        this.buf = Buffer.alloc(0)
        return
      }
    }
  }
}
