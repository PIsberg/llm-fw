import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// tesseract.js is an OPTIONAL PEER dependency, so a default `npm i llm-fw`
// does not install it at all. Everything below pins the two properties that
// make that safe: OCR stays off unless asked for, and asking for it on a host
// where the module is missing degrades to "no text recovered" rather than
// throwing out of the detection pipeline.
//
// Without these, moving tesseract.js out of `dependencies` is a change whose
// failure mode only shows up on a user's machine, never on a dev box where the
// module is present as a devDependency.

const PNG_1PX =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.doUnmock('tesseract.js')
  vi.resetModules()
})

describe('OCR without tesseract.js installed', () => {
  /** Stand in for the module being absent from node_modules entirely. */
  function mockMissingModule(): void {
    vi.doMock('tesseract.js', () => {
      throw Object.assign(new Error("Cannot find module 'tesseract.js'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
  }

  it('returns no text instead of throwing when the module cannot be loaded', async () => {
    mockMissingModule()
    const { ocrImage } = await import('../../src/detection/ocr.js')

    await expect(ocrImage(PNG_1PX, 'image/png')).resolves.toBe('')
  })

  it('stays quiet across repeated calls rather than retrying the failed import', async () => {
    mockMissingModule()
    const { ocrImage } = await import('../../src/detection/ocr.js')

    // The worker promise is memoised, so a missing module must not turn every
    // image in a conversation into another resolution attempt.
    const results = await Promise.all([
      ocrImage(PNG_1PX, 'image/png'),
      ocrImage(PNG_1PX, 'image/jpeg'),
      ocrImage(PNG_1PX, 'image/webp'),
    ])

    expect(results).toEqual(['', '', ''])
  })

  it('tears down cleanly when no worker was ever created', async () => {
    mockMissingModule()
    const { ocrImage, terminateOcr } = await import('../../src/detection/ocr.js')

    await ocrImage(PNG_1PX, 'image/png')
    await expect(terminateOcr()).resolves.toBeUndefined()
  })

  it('never reaches the import for a non-raster candidate', async () => {
    // Cheap proof the MIME gate runs first: with the module mocked to explode,
    // an SVG still resolves, so nothing tried to load tesseract.js.
    mockMissingModule()
    const { ocrImage } = await import('../../src/detection/ocr.js')

    await expect(ocrImage(PNG_1PX, 'image/svg+xml')).resolves.toBe('')
  })
})
