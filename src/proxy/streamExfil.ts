// Exfil URLs in a streamed response, under responseScan.mode 'block' (#551).
//
// A URL is only recognisable once it is complete, and the secret in its query
// string streams before its end. So the stream is held while the model's text
// is writing a URL a client would fetch or link, the held text is scanned,
// and its events are forwarded in order or the stream is cut. Everything
// else, most of a response, is forwarded event by event as before.
//
// What is held is keyed to where the URL is, not to markdown's bracket
// structure, whose escapes, code spans and nesting end link text where a
// simple parser would not (each of those was a bypass of an earlier version):
// - every `](`: from the `]` (one character, to see whether `(` follows)
//   to the end of the URL after it, wherever it appears;
// - every `<img` tag: to its `>` outside quotes.
// A blank line ends either, as no markup spans a paragraph. The held text is
// judged by the scanner a buffered response goes through, and each `](url`
// and `src=url` in it is also judged on its own, so markup that scanner
// cannot parse is still caught.
//
// Measured live through Claude Code on an answer full of links and code:
// holding to the end of the line delayed it by up to 2.5 s; holding to the
// end of the markup by 151 ms at most.
//
// Only text a client renders is read. Tool-call argument JSON (`partial_json`,
// `arguments`) is not rendered, and the end-of-stream audit scan covers it.

import { sseEventText } from './canary.js'

const RENDERED_KEYS: ReadonlySet<string> = new Set(['text', 'thinking', 'content', 'refusal', 'delta', 'output'])
const EVENT_END = /\r?\n\r?\n/
const IMG = '<img'
// The URL after a `](` and in a `src=` attribute, wherever they sit.
const LINK_URL = /\]\(\s*<?(https?:\/\/[^\s)>]+)/gi
const SRC_URL = /\bsrc\s*=\s*["']?(https?:\/\/[^"'\s>]+)/gi

// text: nothing held. close: just after `]`. url: inside `](`, before the URL ends.
type Link = 'text' | 'close' | 'url'

/**
 * Holds the events of an SSE response while model text is writing a URL.
 * push() and end() return the raw text that is safe to forward now, or null
 * when the held text carries an exfil URL: the caller cuts the stream, and
 * nothing of that URL has been forwarded. `isExfil` sees each held stretch
 * once it settles. Linear in the response.
 */
export class ExfilStreamHold {
  private buf = ''
  private held = ''
  private link: Link = 'text'
  private urlStarted = false
  // Whether the last `[` was an image's `![`, to label what the scan reports.
  private image = false
  // The `<img` prefix matched so far, whether a tag is open, and the quote
  // its attribute value is inside.
  private lt = ''
  private tag = false
  private quote = ''
  private pending = ''
  private prev = ''
  private recent = ''
  private newlines = 0

  constructor(private readonly isExfil: (text: string) => boolean) {}

  push(raw: string): string | null {
    this.buf += raw
    let out = ''
    for (let m = EVENT_END.exec(this.buf); m !== null; m = EVENT_END.exec(this.buf)) {
      const end = m.index + m[0].length
      const event = this.buf.slice(0, end)
      this.buf = this.buf.slice(end)
      if (!this.take(sseEventText(event, RENDERED_KEYS) ?? '')) return null
      if (this.holding()) this.held += event
      else { out += this.held + event; this.held = '' }
    }
    return out
  }

  /** The stream ended: judge what is still held, and release what is left. */
  end(): string | null {
    const rest = this.buf
    this.buf = ''
    if (!this.take(sseEventText(rest, RENDERED_KEYS) ?? '')) return null
    if (this.holding() && this.carriesExfil()) return null
    const out = this.held + rest
    this.held = ''
    return out
  }

  private holding(): boolean {
    return this.link !== 'text' || this.tag
  }

  private carriesExfil(): boolean {
    const text = this.pending
    if (this.isExfil(text)) return true
    for (const m of text.matchAll(LINK_URL)) if (this.isExfil(`${this.image ? '!' : ''}[x](${m[1]})`)) return true
    for (const m of text.matchAll(SRC_URL)) if (this.isExfil(`<img src="${m[1]}">`)) return true
    return false
  }

  /** Feeds one event's text; false when held text it settles carries exfil. */
  private take(text: string): boolean {
    for (const c of text) {
      const was = this.holding()
      this.recent = (this.recent + c).slice(-IMG.length)
      this.newlines = c === '\n' ? this.newlines + 1 : c === '\r' ? this.newlines : 0
      if (c === '[') this.image = this.prev === '!'
      this.stepLink(c)
      this.stepImage(c)
      if (this.newlines >= 2) { this.link = 'text'; this.tag = false; this.quote = ''; this.lt = '' }
      const now = this.holding()
      if (!was && now) this.pending = this.tag ? this.recent : c
      else if (was) this.pending += c
      if (was && !now) {
        if (this.carriesExfil()) return false
        this.pending = ''
      }
      this.prev = c
    }
    return true
  }

  private stepLink(c: string): void {
    switch (this.link) {
      case 'text':
        if (c === ']') this.link = 'close'
        return
      case 'close':
        if (c === '(') { this.link = 'url'; this.urlStarted = false }
        else if (c !== ']') this.link = 'text'
        return
      case 'url':
        // `](  <https://...` may open with whitespace and `<`; the URL ends at
        // `)`, `>` or whitespace after it.
        if (!this.urlStarted) {
          if (c === ')') this.link = 'text'
          else this.urlStarted = !/\s|</.test(c)
        } else if (c === ')' || c === '>' || /\s/.test(c)) {
          this.link = 'text'
        }
        return
    }
  }

  private stepImage(c: string): void {
    if (this.tag) {
      if (this.quote) { if (c === this.quote) this.quote = '' }
      else if (c === '"' || c === "'") this.quote = c
      else if (c === '>') this.tag = false
      return
    }
    const next = (this.lt + c).toLowerCase()
    if (IMG.startsWith(next)) this.lt = next
    else this.lt = c === '<' ? '<' : ''
    if (this.lt === IMG) { this.tag = true; this.quote = ''; this.lt = '' }
  }
}
