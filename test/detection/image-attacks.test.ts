import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { AnthropicParser } from '../../src/detection/parsers.js'
import { terminateOcr } from '../../src/detection/ocr.js'
import type { BlockEvent, Config } from '../../src/types.js'

// Real-world prompt-injection screenshots: payloads (zero-size HTML, hidden SVG
// CDATA, base64 data-attributes, "SYSTEM OVERRIDE", etc.) rendered as pixels in
// a PNG, the way a user would paste a screenshot into a multimodal model. There
// is NO extractable text in the file bytes — the injection lives only in pixels.
//
// Two defenses, two test groups below:
//   • Without OCR (default): the firewall can't read pixels, so it handles the
//     image on the uninspectable-media path — audit mode passes but fires a
//     non-text warn (never silent); block mode refuses it regardless of content.
//   • With OCR (nonText.ocr, opt-in): the pixels are read and scanned like any
//     prompt, so a screenshot blocks on CONTENT — even in audit mode.
const IMAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'attack-images')
const IMAGE_FILES = readdirSync(IMAGE_DIR)
  .filter(f => /\.png$/i.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

const cfg = (mode: 'audit' | 'block'): Config => ({
  ...DEFAULT_CONFIG,
  detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
  nonText: { enabled: true, mode },
})
const meta = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages' }

// Wrap a base64 image exactly as the dashboard playground / a multimodal client
// would: an Anthropic /v1/messages request with a text prompt + an image block.
function imageBody(b64: string): string {
  return JSON.stringify({
    model: 'claude-3-haiku-20240307',
    max_tokens: 1,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } },
      ],
    }],
  })
}

const asB64 = (f: string) => readFileSync(join(IMAGE_DIR, f)).toString('base64')

describe('image prompt-injection screenshots (issue #60)', () => {
  it('ships the attack-image corpus', () => {
    expect(IMAGE_FILES.length).toBeGreaterThanOrEqual(16)
  })

  it.each(IMAGE_FILES)('%s — raster injection has no extractable text (opaque)', (file) => {
    const blocks = new AnthropicParser().extractMediaBlocks(imageBody(asB64(file)))
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.kind).toBe('image')
    // No OCR: the injection rendered in pixels is invisible to text extraction.
    expect(blocks[0]?.text).toBeUndefined()
  })

  it.each(IMAGE_FILES)('%s — block mode refuses the uninspectable image', async (file) => {
    const events: Omit<BlockEvent, 'id' | 'timestamp'>[] = []
    const pipeline = new Pipeline(cfg('block'), e => events.push(e))
    const result = await pipeline.run('/v1/messages', imageBody(asB64(file)), meta)
    expect(result.action).toBe('block')
    expect(result.stage).toBe('non-text')
    expect(events[0]?.kind).toBe('non-text')
    expect(events[0]?.mediaSummary).toBe('image/png')
  })

  it.each(IMAGE_FILES)('%s — audit mode passes but emits a non-text warn', async (file) => {
    const events: Omit<BlockEvent, 'id' | 'timestamp'>[] = []
    const pipeline = new Pipeline(cfg('audit'), e => events.push(e))
    const result = await pipeline.run('/v1/messages', imageBody(asB64(file)), meta)
    // Audit default lets the image through (no OCR to justify a block on
    // content) but surfaces it so it is never invisible.
    expect(result.action).toBe('pass')
    const warn = events.find(e => e.kind === 'non-text')
    expect(warn?.action).toBe('warned')
    expect(warn?.mediaSummary).toBe('image/png')
  })
})

// OCR (nonText.ocr) reads the injection text out of the pixels and feeds it to
// the normal pipeline, so a screenshot blocks on CONTENT — even in audit mode,
// and a benign text-free image still passes. Gated behind RUN_OCR: the first
// run downloads ~12 MB of tesseract.js core + language data over the network and
// each image takes ~0.2–2s, neither of which belongs in the default CI path.
const ocrAudit: Config = {
  ...DEFAULT_CONFIG,
  detection: { ...DEFAULT_CONFIG.detection, judgeEnabled: false },
  nonText: { enabled: true, mode: 'audit', ocr: true },
}
const ocrBlock: Config = { ...ocrAudit, nonText: { enabled: true, mode: 'block', ocr: true } }

// Images whose imperative is visible plaintext: OCR recovers it and a content
// stage blocks, regardless of nonText.mode.
const CONTENT_BLOCKED = [
  'attack1.png', 'attack4.png', 'attack6.png', 'attack7.png', 'attack8.png', 'attack9.png',
  'attack10.png', 'attack11.png', 'attack12.png', 'attack13.png', 'attack14.png', 'attack15.png', 'attack16.png',
]
// Images that encode the imperative as base64 / HTML entities inside the pixels.
// OCR cannot cleanly recover the dense encoded bytes, so no content stage fires
// on the OCR text — block mode's opacity refusal is the backstop here.
const ENCODED_RESIDUAL = ['attack2.png', 'attack3.png', 'attack5.png']

// 1×1 transparent PNG — a real raster image with no legible text.
const PNG_BLANK = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe.skipIf(!process.env['RUN_OCR'])('image OCR content detection (nonText.ocr)', () => {
  afterAll(async () => { await terminateOcr() })

  it('the two corpora together account for every fixture', () => {
    expect([...CONTENT_BLOCKED, ...ENCODED_RESIDUAL].sort()).toEqual([...IMAGE_FILES].sort())
  })

  it.each(CONTENT_BLOCKED)('%s — OCR recovers the injection and blocks on content (audit mode)', async (file) => {
    const result = await new Pipeline(ocrAudit, () => {}).run('/v1/messages', imageBody(asB64(file)), meta)
    expect(result.action).toBe('block')
    // Blocked by a content stage (heuristic/embedding/…) on the recovered text,
    // NOT by the blanket non-text opacity refusal.
    expect(result.stage).not.toBe('non-text')
  }, 30_000)

  it.each(ENCODED_RESIDUAL)('%s — encoded payload OCR cannot recover is still caught by block mode', async (file) => {
    const result = await new Pipeline(ocrBlock, () => {}).run('/v1/messages', imageBody(asB64(file)), meta)
    expect(result.action).toBe('block')
    expect(result.stage).toBe('non-text')
  }, 30_000)

  it('a text-free raster image still passes (no false block from OCR)', async () => {
    const result = await new Pipeline(ocrAudit, () => {}).run('/v1/messages', imageBody(PNG_BLANK), meta)
    expect(result.action).toBe('pass')
  }, 30_000)
})
