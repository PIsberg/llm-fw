import { describe, it, expect } from 'vitest'
import { collectTextSlots } from '../../src/modules/payload.js'

const kinds = (payload: unknown) => collectTextSlots(payload).map(s => `${s.kind}:${s.text}`)

describe('collectTextSlots — OpenAI chat', () => {
  it('classifies system, developer, user, assistant and tool messages', () => {
    expect(kinds({
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'developer', content: 'dev' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        { role: 'tool', tool_call_id: 'call_1', content: 'ls output' },
      ],
    })).toEqual(['system:sys', 'system:dev', 'prompt:hi', 'prompt:hello', 'tool_result:ls output'])
  })

  it('carries the tool call id of a tool message', () => {
    const [slot] = collectTextSlots({ messages: [{ role: 'tool', tool_call_id: 'call_9', content: 'x' }] })
    expect(slot?.toolCallId).toBe('call_9')
  })

  it('reads text parts of a tool message', () => {
    expect(kinds({ messages: [{ role: 'tool', tool_call_id: 'c', content: [{ type: 'text', text: 'part' }] }] }))
      .toEqual(['tool_result:part'])
  })
})

describe('collectTextSlots — Anthropic messages', () => {
  it('reads a string and a block system prompt', () => {
    expect(kinds({ system: 'one', messages: [] })).toEqual(['system:one'])
    expect(kinds({ system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [] }))
      .toEqual(['system:a', 'system:b'])
  })

  it('reads tool_result blocks, string and nested, with their tool_use_id', () => {
    const slots = collectTextSlots({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'flat' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: [{ type: 'text', text: 'nested' }, { type: 'image', source: {} }] },
          { type: 'text', text: 'and a question' },
        ],
      }],
    })
    expect(slots.map(s => [s.kind, s.text, s.toolCallId])).toEqual([
      ['tool_result', 'flat', 'toolu_1'],
      ['tool_result', 'nested', 'toolu_2'],
      ['prompt', 'and a question', undefined],
    ])
  })

  it('never yields thinking blocks, whose signature must not change', () => {
    expect(kinds({
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'secret', signature: 's' }, { type: 'text', text: 'answer' }] }],
    })).toEqual(['prompt:answer'])
  })
})

describe('collectTextSlots — OpenAI Responses API', () => {
  it('reads instructions, a string input, message items and function_call_output', () => {
    expect(kinds({ instructions: 'be brief', input: 'question' })).toEqual(['system:be brief', 'prompt:question'])
    const slots = collectTextSlots({
      input: [
        { role: 'user', content: [{ type: 'input_text', text: 'q' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
        { type: 'function_call_output', call_id: 'call_3', output: 'result' },
      ],
    })
    expect(slots.map(s => [s.kind, s.text, s.toolCallId])).toEqual([
      ['prompt', 'q', undefined],
      ['prompt', 'a', undefined],
      ['tool_result', 'result', 'call_3'],
    ])
  })
})

describe('collectTextSlots — Gemini', () => {
  it('reads systemInstruction and contents parts, skipping functionResponse objects', () => {
    expect(kinds({
      systemInstruction: { parts: [{ text: 'sys' }] },
      contents: [{ role: 'user', parts: [{ text: 'q' }, { functionResponse: { name: 'f', response: { a: 1 } } }] }],
    })).toEqual(['system:sys', 'prompt:q'])
  })

  it('reads the legacy single prompt field', () => {
    expect(kinds({ prompt: 'complete me' })).toEqual(['prompt:complete me'])
  })
})

describe('collectTextSlots — tool definitions', () => {
  it('reads descriptions from Anthropic, OpenAI chat, Responses and Gemini tool shapes', () => {
    expect(kinds({
      tools: [
        { name: 'a', description: 'anthropic tool', input_schema: { type: 'object', properties: { p: { type: 'string', description: 'param a' } } } },
        { type: 'function', function: { name: 'b', description: 'chat tool', parameters: { type: 'object', properties: {} } } },
        { type: 'function', name: 'c', description: 'responses tool', parameters: { type: 'object', properties: { q: { type: 'array', items: { type: 'string', description: 'item c' } } } } },
        { functionDeclarations: [{ name: 'd', description: 'gemini tool' }] },
      ],
      messages: [],
    })).toEqual([
      'tool_definition:anthropic tool', 'tool_definition:param a',
      'tool_definition:chat tool',
      'tool_definition:responses tool', 'tool_definition:item c',
      'tool_definition:gemini tool',
    ])
  })

  it('does not mistake a property named "description" for a description string', () => {
    expect(kinds({
      tools: [{ name: 't', input_schema: { type: 'object', properties: { description: { type: 'string', description: 'the text' } } } }],
    })).toEqual(['tool_definition:the text'])
  })

  it('orders slots as the provider renders them: tools, then system, then messages', () => {
    expect(kinds({ messages: [{ role: 'user', content: 'm' }], system: 's', tools: [{ name: 't', description: 'd' }] }))
      .toEqual(['tool_definition:d', 'system:s', 'prompt:m'])
  })
})

describe('collectTextSlots — writing back', () => {
  it('set() writes through to the payload for every shape', () => {
    const payload = {
      system: [{ type: 'text', text: 's' }],
      tools: [{ name: 't', description: 'd', input_schema: { properties: { p: { description: 'pd' } } } }],
      messages: [
        { role: 'user', content: 'u' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'tr' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: [{ type: 'text', text: 'nested' }] }] },
      ],
    }
    for (const slot of collectTextSlots(payload)) slot.set(slot.text.toUpperCase())
    expect(payload).toEqual({
      system: [{ type: 'text', text: 'S' }],
      tools: [{ name: 't', description: 'D', input_schema: { properties: { p: { description: 'PD' } } } }],
      messages: [
        { role: 'user', content: 'U' },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'TR' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'y', content: [{ type: 'text', text: 'NESTED' }] }] },
      ],
    })
  })

  it('returns no slots for a payload that is not an object', () => {
    expect(collectTextSlots(null)).toEqual([])
    expect(collectTextSlots('text')).toEqual([])
    expect(collectTextSlots([1, 2])).toEqual([])
  })
})
