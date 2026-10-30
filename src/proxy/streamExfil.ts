// Exfil URLs in a streamed response, under responseScan.mode 'block' (#551).
//
// A URL is only recognisable once it is complete, and the secret in its query
// string streams before its end. So the stream is held from the moment model
// text opens markup that can carry one, a markdown `[` or an `<img`, until
// every open markup has settled: `]` not followed by `(`, the end of the URL,
// the tag's `>`, or a blank line. The held text is then scanned whole, and
// its events are forwarded in order or the stream is cut. Everything else,
// most of a response, is forwarded event by event as before.
//
// Markdown and `<img` are tracked independently and the hold lasts while
// either is open, so neither can hide the other: an `<img` inside link text,
// or a whole link inside an attribute, is still held to the end and scanned
// as one piece by the same scanner a buffered response goes through.
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
const IMG = '<img'

// text: nothing open. bracket: inside `[...]`. close: just after `]`.
// url: inside `](...`, before the URL ends.
type Markdown = 'text' | 'bracket' | 'close' | 'url'

/**
 * Holds the events of an SSE response while model text is open markup.
 * push() and end() return the raw text that is safe to forward now, or null
 * when the held markup carries an exfil URL: the caller cuts the stream, and
 * nothing of that markup has been forwarded. `isExfil` sees each held stretch
 * of text once it settles. Linear in the response.
 */
export class ExfilStreamHold {
  private buf = ''
  private held = ''
  private md: Markdown = 'text'
  private urlStarted = false
  // The `<img` prefix matched so far (`<`, `<i`, `<im`), and whether a tag is open.
  private lt = ''
  private tag = false
  // The held text, from the character before `[` (a `!` makes it an image) or
  // from `<` of the tag, whichever opened first.
  private pending = ''
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

  /** The stream ended: judge markup still open, and release what is left. */
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
    return this.md !== 'text' || this.tag
  }

  // A URL ended by whitespace or `>` is judged before the `)` that would
  // close it arrives, so the scan also sees the text closed.
  private carriesExfil(): boolean {
    return this.isExfil(this.pending) || this.isExfil(`${this.pending})`)
  }

  /** Feeds one event's text; false when markup it settles carries exfil. */
  private take(text: string): boolean {
    for (const c of text) {
      const was = this.holding()
      this.recent = (this.recent + c).slice(-IMG.length)
      this.newlines = c === '\n' ? this.newlines + 1 : c === '\r' ? this.newlines : 0
      this.markdown(c)
      this.image(c)
      // A blank line ends a paragraph, and no markup spans one.
      if (this.newlines >= 2) { this.md = 'text'; this.tag = false; this.lt = '' }
      const now = this.holding()
      if (!was && now) this.pending = this.tag ? this.recent : this.recent.slice(-2)
      else if (was) this.pending += c
      if (was && !now) {
        if (this.carriesExfil()) return false
        this.pending = ''
      }
    }
    return true
  }

  private markdown(c: string): void {
    switch (this.md) {
      case 'text':
        if (c === '[') this.md = 'bracket'
        return
      case 'bracket':
        if (c === ']') this.md = 'close'
        return
      case 'close':
        if (c === '(') { this.md = 'url'; this.urlStarted = false }
        else if (c !== '[') this.md = 'text'
        else this.md = 'bracket'
        return
      case 'url':
        // `](  <https://...` may open with whitespace and `<`; the URL ends at
        // `)`, `>` or whitespace after it.
        if (!this.urlStarted) {
          if (c === ')') this.md = 'text'
          else this.urlStarted = !/\s|</.test(c)
        } else if (c === ')' || c === '>' || /\s/.test(c)) {
          this.md = 'text'
        }
        return
    }
  }

  private image(c: string): void {
    if (this.tag) {
      if (c === '>') this.tag = false
      return
    }
    const next = (this.lt + c).toLowerCase()
    if (IMG.startsWith(next)) this.lt = next
    else this.lt = c === '<' ? '<' : ''
    if (this.lt === IMG) { this.tag = true; this.lt = '' }
  }
}
