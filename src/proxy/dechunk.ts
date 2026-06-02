/**
 * Incremental HTTP/1.1 chunked-transfer decoder.
 *
 * Upstream LLM responses — especially streaming SSE — use
 * `Transfer-Encoding: chunked`, so the raw bytes after the headers carry chunk
 * framing (hex size lines + CRLFs). MCP response inspection needs the actual
 * payload, so feed raw body bytes here as they arrive and get back the decoded
 * payload. Chunk boundaries may land anywhere; chunk extensions and trailers
 * are ignored. The passthrough path does NOT use this — it forwards framing
 * verbatim for the client to decode.
 */
export class ChunkedDecoder {
  private buf: Buffer = Buffer.alloc(0)
  private need = 0          // bytes left in the current chunk's data
  private afterData = false // expecting the CRLF that terminates chunk data
  finished = false

  push(raw: Buffer): Buffer {
    this.buf = this.buf.length ? Buffer.concat([this.buf, raw]) : raw
    const out: Buffer[] = []
    for (;;) {
      if (this.afterData) {
        if (this.buf.length < 2) break
        this.buf = this.buf.subarray(2) // skip CRLF after chunk data
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
      const size = parseInt(sizeHex, 16)
      this.buf = this.buf.subarray(idx + 2)
      if (isNaN(size) || size === 0) { this.finished = true; break }
      this.need = size
    }
    return out.length ? Buffer.concat(out) : Buffer.alloc(0)
  }
}
