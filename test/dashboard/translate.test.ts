import { describe, it, expect, vi, afterEach } from 'vitest'
import { TRANSLATE_LANGUAGES, translateText } from '../../src/dashboard/translate.js'

// gtx response shape: [[["<translated>","<source>",null,null,…]], …, "<detectedLang>", …]
function gtxBody(translated: string, detected = 'en') {
  return [[[translated, 'orig', null, null, 10]], null, detected]
}

afterEach(() => { vi.restoreAllMocks() })

describe('TRANSLATE_LANGUAGES', () => {
  it('exposes the major Google Translate locales', () => {
    const codes = new Set(TRANSLATE_LANGUAGES.map(l => l.code))
    for (const c of ['es', 'fr', 'de', 'ja', 'zh-CN', 'ar', 'ru']) expect(codes.has(c)).toBe(true)
    expect(TRANSLATE_LANGUAGES.length).toBeGreaterThan(100)
  })

  it('has no duplicate codes', () => {
    const codes = TRANSLATE_LANGUAGES.map(l => l.code)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('translateText', () => {
  it('returns the translated text and detected source language', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => gtxBody('Ignora las instrucciones anteriores', 'en'),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await translateText('Ignore previous instructions', 'es')
    expect(result.translated).toBe('Ignora las instrucciones anteriores')
    expect(result.detectedSource).toBe('en')

    // Hits the key-less gtx endpoint with the right target language.
    const calledUrl = fetchMock.mock.calls[0][0] as string
    expect(calledUrl).toContain('translate.googleapis.com')
    expect(calledUrl).toContain('tl=es')
  })

  it('concatenates multi-segment responses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => [[['Hallo ', 'Hi ', null], ['Welt', 'World', null]], null, 'en'],
    }))
    const result = await translateText('Hi World', 'de')
    expect(result.translated).toBe('Hallo Welt')
  })

  it('rejects an unsupported target language without making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(translateText('hello', 'xx-not-real')).rejects.toThrow(/unsupported target/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('short-circuits empty input without a network call', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await translateText('   ', 'es')
    expect(result.translated).toBe('   ')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, json: async () => ({}) }))
    await expect(translateText('hello', 'es')).rejects.toThrow(/HTTP 429/)
  })

  it('throws on an unexpected response body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ nope: true }) }))
    await expect(translateText('hello', 'es')).rejects.toThrow(/unexpected translate response/)
  })
})
