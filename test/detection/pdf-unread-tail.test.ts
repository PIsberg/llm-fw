import { describe, it, expect } from 'vitest'
import { mediaBlockFromBase64 } from '../../src/detection/media.js'

/**
 * Security review (2026-11-28): the content-stream reader stopped at a hex
 * string with no closing '>' and ran off the end of a literal string with no
 * closing ')', and counted neither as unread, so a PDF whose page text the
 * reader gave up on still counted as fully inspected and nonText.mode never
 * saw it.
 */
const pdfStream = (content: string) => Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF\n`).toString('base64')
const read = (content: string) => mediaBlockFromBase64('document', 'application/pdf', pdfStream(content))

describe('a content stream the reader gives up on is partial', () => {
  it('reads a well-formed stream as inspected', () => {
    expect(read('BT /F1 12 Tf (Quarterly results.) Tj ET').partial).toBeUndefined()
  })

  it('marks a hex string with no closing bracket unread', () => {
    expect(read('BT /F1 12 Tf (Quarterly results.) Tj ET BT <51756172746572').partial).toBe(true)
  })

  it('marks a literal string with no closing parenthesis unread', () => {
    expect(read('BT /F1 12 Tf (Quarterly results.) Tj ET BT (Quarterly results and more').partial).toBe(true)
  })
})
