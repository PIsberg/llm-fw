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
// - every `](` and `]:` (a reference definition): from the `]` (one
//   character, to see what follows)
//   to the end of the URL after it, wherever it appears;
// - every `<img` tag: to its `>` outside quotes.
// A blank line ends either, as no markup spans a paragraph. The held text is
// judged by the scanner a buffered response goes through, and each held
// destination (read with CommonMark's grammar) and `src=url` is also judged
// on its own, so markup that scanner cannot parse is still caught.
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
// Each URL here may also be scheme-relative (`//host/...`), which a browser
// resolves to https.
// The URL in a `src=` attribute, wherever it sits.
const SRC_URL = /\bsrc\s*=\s*["']?((?:https?:)?\/\/[^"'\s>]+)/gi
// Any URL at all in held text, judged by its host as an image: a destination
// that never closes must not hide another inside it.
const ANY_URL = /(?:https?:)?\/\/[^\s"'<>()[\]\\]+/gi
const IS_URL = /^(?:https?:)?\/\//i
// What a backslash escapes in CommonMark; before anything else it is literal.
const ESCAPABLE = /[!-/:-@[-`{-~]/

// text: nothing held. close: just after `]`. url: inside the destination
// after `](` or `]:`, before it ends.
type Link = 'text' | 'close' | 'url'

/** A held destination, written so the markdown scanner reads it whole. */
function asMarkdown(url: string, image: boolean): string {
  const encoded = url.replace(/[\s()<>\\]/g, ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase())
  return `${image ? '!' : ''}[x](${encoded})`
}

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
  // The destination being held, read the way CommonMark reads one: `<...>`
  // to an unescaped `>`; bare to whitespace or an unbalanced `)`, counting
  // balanced parentheses and taking backslash-escaped characters literally.
  // `]:` (a reference definition) is judged as an image, which is what an
  // image naming its label fetches.
  private urlStarted = false
  private angle = false
  private def = false
  private depth = 0
  private escape = false
  private url = ''
  private urls: { url: string; image: boolean }[] = []
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
    const open = this.holding()
    if (this.link === 'url') this.endUrl()
    if (open && this.carriesExfil()) return null
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
    for (const { url, image } of this.urls) if (IS_URL.test(url) && this.isExfil(asMarkdown(url, image))) return true
    for (const m of text.matchAll(SRC_URL)) if (this.isExfil(`<img src="${m[1]}">`)) return true
    for (const m of text.matchAll(ANY_URL)) if (this.isExfil(`![x](${m[0]})`)) return true
    return false
  }

  private endUrl(): void {
    this.urls.push({ url: this.url, image: this.def || this.image })
    this.url = ''
    this.depth = 0
    this.escape = false
    this.link = 'text'
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
      if (this.newlines >= 2) {
        if (this.link === 'url') this.endUrl()
        this.link = 'text'; this.tag = false; this.quote = ''; this.lt = ''
      }
      const now = this.holding()
      if (!was && now) { this.pending = this.tag ? this.recent : c; this.urls = [] }
      else if (was) this.pending += c
      if (was && !now) {
        if (this.carriesExfil()) return false
        this.pending = ''
        this.urls = []
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
        // `](` opens an inline URL, `]:` a reference definition's.
        if (c === '(' || c === ':') {
          this.link = 'url'
          this.def = c === ':'
          this.urlStarted = false
          this.url = ''
          this.depth = 0
          this.escape = false
        } else if (c !== ']') {
          this.link = 'text'
        }
        return
      case 'url':
        this.stepUrl(c)
        return
    }
  }

  private stepUrl(c: string): void {
    if (!this.urlStarted) {
      if (/\s/.test(c)) return
      this.urlStarted = true
      if (c === '<') { this.angle = true; return }
      this.angle = false
      if (c === ')' && !this.def) { this.endUrl(); return }
    }
    if (this.escape) { this.url += ESCAPABLE.test(c) ? c : `\\${c}`; this.escape = false; return }
    if (c === '\\') { this.escape = true; return }
    if (this.angle) {
      if (c === '>' || c === '\n') this.endUrl()
      else this.url += c
      return
    }
    if (/\s/.test(c)) { this.endUrl(); return }
    if (c === '(') this.depth++
    else if (c === ')') {
      if (this.depth === 0) { this.endUrl(); return }
      this.depth--
    }
    this.url += c
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
