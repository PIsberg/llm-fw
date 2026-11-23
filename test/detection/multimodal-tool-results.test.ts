import { describe, it, expect } from 'vitest'
import { Pipeline } from '../../src/detection/pipeline.js'
import { AnthropicParser, OpenAIParser, GeminiParser } from '../../src/detection/parsers.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// #857: a tool can return images and files, not only text. On the Responses
// API and Gemini those parts were never read as media: a file in a function
// output was stringified as JSON, a computer_call_output screenshot and an
// image in a Gemini functionResponse were skipped, so nonText.mode 'block'
// never saw them and a text file's content was not decoded.
const b64 = (s: string) => Buffer.from(s, 'utf-8').toString('base64')
const NOTE = 'Quarterly numbers are attached for review.'
// 1x1 transparent PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const blockMode = (): Config => ({ ...structuredClone(DEFAULT_CONFIG), nonText: { enabled: true, mode: 'block' } })

describe('Responses API tool outputs with media (#857)', () => {
  const o = new OpenAIParser()
  const META = { target: 'api.openai.com', method: 'POST', path: '/v1/responses' }
  const body = (output: unknown, type = 'function_call_output') => JSON.stringify({
    model: 'gpt-5',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Check the report.' }] },
      { type: 'function_call', call_id: 'c1', name: 'fetch_report', arguments: '{}' },
      { type, call_id: 'c1', output },
    ],
  })

  it('decodes a text file in a function output as media', () => {
    const output = [{ type: 'input_text', text: 'Here it is.' }, { type: 'input_file', filename: 'note.txt', file_data: `data:text/plain;base64,${b64(NOTE)}` }]
    expect(o.extractMediaBlocks(body(output)).map(m => m.text)).toContain(NOTE)
  })

  it('refuses an image in a function output in block mode', async () => {
    const output = [{ type: 'input_image', image_url: `data:image/png;base64,${PNG}` }]
    expect((await new Pipeline(blockMode()).run('/v1/responses', body(output), META)).stage).toBe('non-text')
  })

  it('refuses a computer_call_output screenshot in block mode', async () => {
    const output = { type: 'computer_screenshot', image_url: `data:image/png;base64,${PNG}` }
    expect((await new Pipeline(blockMode()).run('/v1/responses', body(output, 'computer_call_output'), META)).stage).toBe('non-text')
  })
})

describe('Gemini functionResponse parts (#857)', () => {
  const g = new GeminiParser()
  const PATH = '/v1beta/models/gemini-2.5-pro:generateContent'
  const META = { target: 'generativelanguage.googleapis.com', method: 'POST', path: PATH }
  const body = (parts: unknown[]) => JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: 'Check the report.' }] },
      { role: 'model', parts: [{ functionCall: { name: 'fetch_report', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'fetch_report', response: { output: 'ok' }, parts } }] },
    ],
  })

  it('decodes a text file in a functionResponse as media', () => {
    expect(g.extractMediaBlocks(body([{ inlineData: { mimeType: 'text/plain', data: b64(NOTE) } }])).map(m => m.text)).toContain(NOTE)
  })

  it('refuses an image in a functionResponse in block mode', async () => {
    expect((await new Pipeline(blockMode()).run(PATH, body([{ inlineData: { mimeType: 'image/png', data: PNG } }]), META)).stage).toBe('non-text')
  })
})

describe('tool result blocks with text beside their content (#857)', () => {
  it('keeps a block title and context next to its nested content', () => {
    const body = JSON.stringify({ messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'search', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
        { type: 'search_result', title: 'Result title text', source: 'https://x.example', context: 'Result context text', content: [{ type: 'text', text: 'Result body text' }] },
      ] }] },
    ] })
    const result = new AnthropicParser().extractToolResults(body)[0]!.result
    for (const t of ['Result title text', 'Result context text', 'Result body text']) expect(result).toContain(t)
  })
})
