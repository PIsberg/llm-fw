// Exfil URLs in a streamed response, under responseScan.mode 'block' (#551).
//
// A URL is only recognisable once it is complete, and the secret in its query
// string streams before its end. So the stream is held from the moment model
// text opens markup that can carry one (`[` of a markdown link or image,
// `<img`) until that markup settles: `]` not followed by `(`, the URL ending,
// `>` closing the tag, or a blank line. The settled markup is scanned before
// any of its events are forwarded. Everything else, most of a response, is
// forwarded event by event as before.
//
// Settling at markup rather than at the end of the line matters: a markdown
// paragraph is one line, and holding to its end delayed a live Claude Code
// answer with a list of links by up to 2.5 s.
//
// Only text a client renders is read. Tool-call argument JSON (`partial_json`,
// `arguments`) is not rendered, holds `[` constantly, and the end-of-stream
// audit scan still covers it.

import { sseEventText } from './canary.js'

const RENDERED_KEYS: ReadonlySet<string> = new Set(['text', 'thinking', 'content', 'refusal', 'delta', 'output'])
const EVENT_END = /\r?\n\r?\n/

// text: no markup open. lt: `<`, `<i` or `<im` seen (nothing to hold yet).
// bracket: inside `[...]`. close: just after `]`. url: inside `](...`, before
// the URL ends. tag: inside `<img ...`.
type State = 'text' | 'lt' | 'bracket' | 'close' | 'url' | 'tag'

/**
 * Holds the events of an SSE response while model text is open markup.
 * push() and end() return the raw text that is safe to forward now, or null
 * when settled markup carries an exfil URL: the caller cuts the stream, and
 * nothing of that markup has been forwarded. `isExfil` sees the text of each
 * markup that settled with a URL in it, once. Linear in the response.
 */
export class ExfilStreamHold {
  private buf = ''
  private held = ''
  private state: State = 'text'
  // The open markup's text, from the character before `[` (a `!` makes it an
  // image) or from `<`.
  private markup = ''
  private prev = ''
  private urlStarted = false
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

  /** The stream ended: judge markup still open, and release what is left. */
  end(): string | null {
    const rest = this.buf
    this.buf = ''
    if (!this.take(sseEventText(rest, RENDERED_KEYS) ?? '')) return null
    if (this.state === 'url' && this.isExfil(`${this.markup})`)) return null
    if (this.state === 'tag' && this.isExfil(this.markup)) return null
    const out = this.held + rest
    this.held = ''
    return out
  }

  private holding(): boolean {
    return this.state === 'bracket' || this.state === 'close' || this.state === 'url' || this.state === 'tag'
  }

  /** Feeds one event's text; false when markup it settles carries exfil. */
  private take(text: string): boolean {
    for (const c of text) {
      if (!this.step(c)) return false
      this.prev = c
    }
    return true
  }

  private settle(scan: string | null): boolean {
    this.state = 'text'
    this.markup = ''
    return scan === null || !this.isExfil(scan)
  }

  private step(c: string): boolean {
    if (this.state !== 'text' && this.state !== 'lt') {
      this.markup += c
      // A blank line ends a paragraph, and no markup spans one.
      this.newlines = c === '\n' ? this.newlines + 1 : c === '\r' ? this.newlines : 0
      if (this.newlines >= 2) return this.settle(this.state === 'url' ? `${this.markup})` : this.state === 'tag' ? this.markup : null)
    }
    switch (this.state) {
      case 'lt':
        this.markup += c
        if ('<img'.startsWith(this.markup.toLowerCase())) {
          if (this.markup.length === 4) this.state = 'tag'
          return true
        }
        this.state = 'text'
        this.markup = ''
        return this.step(c)
      case 'text':
        if (c === '[') { this.state = 'bracket'; this.markup = this.prev + c; this.newlines = 0 }
        else if (c === '<') { this.state = 'lt'; this.markup = c }
        return true
      case 'bracket':
        if (c === ']') this.state = 'close'
        return true
      case 'close':
        if (c === '(') { this.state = 'url'; this.urlStarted = false }
        else if (c === '[') this.state = 'bracket'
        else { this.settle(null); return this.step(c) }
        return true
      case 'url':
        // `](  <https://...` may open with whitespace and `<`; the URL ends at
        // `)`, `>` or whitespace after it. Closing it with `)` lets the scan
        // judge `](url "title` before the title arrives.
        if (!this.urlStarted) {
          if (c === ')') return this.settle(null)
          this.urlStarted = !/\s|</.test(c)
          return true
        }
        if (c === ')') return this.settle(this.markup)
        if (c === '>' || /\s/.test(c)) return this.settle(`${this.markup})`)
        return true
      case 'tag':
        if (c === '>') return this.settle(this.markup)
        return true
    }
  }
}
