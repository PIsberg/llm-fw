import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { encodeFrame, FrameReader, OPCODE, OPENAI_REALTIME, GEMINI_LIVE, refuseRealtime } from '../../src/proxy/websocket.js'
import { OrderedFeed } from '../../src/proxy/realtimeRelay.js'
import { LINEAR_TIME_TIMEOUT, underMs } from '../linearTime.js'

// #867: WebSocket relay gaps.
const bodies = (plan: { scans: unknown[] }) => plan.scans.map(s => (s as { body?: string }).body ?? '').join('\n')

describe('#867 Gemini Live: every field of a message is read', () => {
  it('reads clientContent and toolResponse sent beside realtimeInput', () => {
    const plan = GEMINI_LIVE.plan({
      realtimeInput: {},
      clientContent: { turns: [{ role: 'user', parts: [{ text: 'turn text beside realtime input' }] }] },
      toolResponse: { functionResponses: [{ id: 'f1', name: 'lookup', response: { output: 'tool text beside realtime input' } }] },
    }, false)
    expect(bodies(plan)).toContain('turn text beside realtime input')
    expect(bodies(plan)).toContain('tool text beside realtime input')
    expect(plan.dlp).toBe(true)
  })

  it('scans inline data that is neither PCM audio nor an image, as a file', () => {
    const pdf = Buffer.from('%PDF-1.4 hidden').toString('base64')
    const cc = GEMINI_LIVE.plan({ clientContent: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'application/pdf', data: pdf } }] }] } }, false)
    expect(bodies(cc)).toContain(`data:application/pdf;base64,${pdf}`)
    const ri = GEMINI_LIVE.plan({ realtimeInput: { mediaChunks: [{ mimeType: 'text/plain', data: Buffer.from('notes').toString('base64') }] } }, false)
    expect(bodies(ri)).toContain('data:text/plain;base64,')
  })
})

// Security review of #867: protobuf's JSON mapping accepts each field's proto
// name as well as its lowerCamelCase one, and the relay read only the latter,
// so the same message in snake_case went through unscanned.
describe('#867 Gemini Live: both spellings of every field', () => {
  const text = (s: string) => s
  it('reads client_content, tool_response, realtime_input text and inline_data', () => {
    expect(bodies(GEMINI_LIVE.plan({ client_content: { turns: [{ role: 'user', parts: [{ text: text('snake turn text') }] }] } }, false))).toContain('snake turn text')
    expect(bodies(GEMINI_LIVE.plan({ tool_response: { function_responses: [{ id: 'f', name: 'n', response: { output: 'snake tool text' } }] } }, false))).toContain('snake tool text')
    expect(bodies(GEMINI_LIVE.plan({ realtime_input: { text: 'snake realtime text' } }, false))).toContain('snake realtime text')
    const pdf = Buffer.from('%PDF-1.4').toString('base64')
    expect(bodies(GEMINI_LIVE.plan({ client_content: { turns: [{ role: 'user', parts: [{ inline_data: { mime_type: 'application/pdf', data: pdf } }] }] } }, false))).toContain(pdf)
  })

  it('buffers realtime_input media_chunks audio and ends the turn on activity_end', () => {
    const pcm = Buffer.alloc(320).toString('base64')
    const plan = GEMINI_LIVE.plan({ realtime_input: { media_chunks: [{ mime_type: 'audio/pcm;rate=16000', data: pcm }], activity_end: {} } }, false)
    expect(plan.audio).toHaveLength(1)
    expect(plan.scans).toContainEqual({ kind: 'audio' })
  })

  it('reads both spellings when a message carries both', () => {
    const plan = GEMINI_LIVE.plan({
      clientContent: { turns: [{ role: 'user', parts: [{ text: 'camel copy' }] }] },
      client_content: { turns: [{ role: 'user', parts: [{ text: 'snake copy' }] }] },
    }, false)
    expect(bodies(plan)).toContain('camel copy')
    expect(bodies(plan)).toContain('snake copy')
  })

  it('reads an inline part whose two mime types disagree as an opaque file', () => {
    const plan = GEMINI_LIVE.plan({ clientContent: { turns: [{ role: 'user', parts: [{ inlineData: { mimeType: 'audio/pcm', mime_type: 'text/plain', data: 'aGk=' } }] }] } }, false)
    expect(bodies(plan)).toContain('data:application/octet-stream;base64,aGk=')
  })

  it('reads a fileData part as a file it cannot open', () => {
    const plan = GEMINI_LIVE.plan({ clientContent: { turns: [{ role: 'user', parts: [{ file_data: { file_uri: 'gs://bucket/notes.pdf', mime_type: 'application/pdf' } }] }] } }, false)
    expect(bodies(plan)).toContain('gs://bucket/notes.pdf')
  })

  it('runs DLP whenever the message holds anything but media-only realtime input', () => {
    const pcm = Buffer.alloc(32).toString('base64')
    expect(GEMINI_LIVE.plan({ realtimeInput: { audio: { mimeType: 'audio/pcm', data: pcm } } }, false).dlp).toBe(false)
    expect(GEMINI_LIVE.plan({ realtimeInput: { audio: { mimeType: 'audio/pcm', data: pcm } }, extra_field: 'x' }, false).dlp).toBe(true)
  })
})

describe('#867 OpenAI Realtime: images in a conversation item', () => {
  it('scans an input_image part', () => {
    const url = 'data:image/png;base64,iVBORw0KGgo='
    const plan = OPENAI_REALTIME.plan({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: url }] } }, false)
    expect(bodies(plan)).toContain(url)
  })
})

describe('#867 refuseRealtime close reason', () => {
  it('caps the reason at 123 bytes of UTF-8 without splitting a character', () => {
    const writes: Buffer[] = []
    const client = Object.assign(new EventEmitter(), { write: (b: Buffer) => { writes.push(b); return true }, end: vi.fn(), destroy: vi.fn() })
    refuseRealtime(client as never, null, 'blocked: ' + 'ü€😀'.repeat(40))
    const [close] = new FrameReader().push(Buffer.concat(writes))
    expect(close!.opcode).toBe(OPCODE.close)
    expect(close!.payload.length).toBeLessThanOrEqual(125)
    const reason = close!.payload.subarray(2)
    expect(Buffer.from(reason.toString('utf8'), 'utf8').equals(reason)).toBe(true)
  })
})

describe('#867 FrameReader on a large frame in small chunks', () => {
  it('reads an 8 MiB frame arriving 4 KiB at a time in linear time', { timeout: LINEAR_TIME_TIMEOUT }, () => {
    const frame = encodeFrame(OPCODE.binary, Buffer.alloc(8 * 1024 * 1024, 7), false)
    expect(underMs(500, () => {
      const r = new FrameReader(16 * 1024 * 1024)
      let n = 0
      for (let i = 0; i < frame.length; i += 4096) n += r.push(frame.subarray(i, i + 4096)).length
      expect(n).toBe(1)
    })).toBeLessThan(500)
  })
})

describe('#867 OrderedFeed: client messages wait in order, and the client waits when too much does', () => {
  it('pauses the source past the limit and resumes once the backlog drains', async () => {
    const source = { pause: vi.fn(), resume: vi.fn() }
    const feed = new OrderedFeed(source, 1000, () => {})
    const gates: Array<() => void> = []
    const order: number[] = []
    for (let i = 0; i < 4; i++) feed.push(400, () => new Promise<void>(r => gates.push(() => { order.push(i); r() })))
    expect(source.pause).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 4; i++) { await vi.waitFor(() => expect(gates.length).toBeGreaterThan(i)); gates[i]!() }
    await vi.waitFor(() => expect(source.resume).toHaveBeenCalledTimes(1))
    expect(order).toEqual([0, 1, 2, 3])
  })

  it('does not pause under the limit', async () => {
    const source = { pause: vi.fn(), resume: vi.fn() }
    const feed = new OrderedFeed(source, 1000, () => {})
    feed.push(400, async () => {})
    feed.push(400, async () => {})
    await new Promise(r => setTimeout(r, 0))
    expect(source.pause).not.toHaveBeenCalled()
  })
})
