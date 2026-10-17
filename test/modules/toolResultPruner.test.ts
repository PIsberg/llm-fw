import { describe, it, expect } from 'vitest'
import { ToolResultPrunerModule, minifyJsonText } from '../../src/modules/builtin/toolResultPruner.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const on = (extra: Record<string, boolean> = {}) => ({ enabled: true, minifyJson: true, trimTrailing: true, collapseSpaceRuns: false, ...extra })
const toolResult = (content: string) => JSON.stringify({
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }, { type: 'text', text: 'keep   this' }] }],
})
const run = (mod: ToolResultPrunerModule, content: string) => {
  const parsed = JSON.parse(mod.transformRequest(toolResult(content), ctx).body)
  return { result: parsed.messages[0].content[0].content as string, prompt: parsed.messages[0].content[1].text as string }
}

describe('minifyJsonText', () => {
  it('drops whitespace outside strings and keeps every literal byte for byte', () => {
    // JSON.parse + stringify would turn the id into 12345678901234567000
    // and 1.50 into 1.5; an agent then quotes the wrong id back.
    const pretty = '{\n  "id": 12345678901234567890,\n  "price": 1.50,\n  "note": "two  spaces\\n kept",\n  "list": [ 1, 2 ]\n}'
    expect(minifyJsonText(pretty)).toBe('{"id":12345678901234567890,"price":1.50,"note":"two  spaces\\n kept","list":[1,2]}')
  })

  it('keeps an escaped quote inside a string', () => {
    expect(minifyJsonText('{ "a" : "say \\"hi  there\\"" }')).toBe('{"a":"say \\"hi  there\\""}')
  })

  it('returns null for text that is not a JSON object or array', () => {
    expect(minifyJsonText('plain text')).toBeNull()
    expect(minifyJsonText('{ not: json }')).toBeNull()
    expect(minifyJsonText('"just a string"')).toBeNull()
    expect(minifyJsonText('42')).toBeNull()
  })
})

describe('ToolResultPrunerModule', () => {
  it('minifies a tool result that is pretty-printed JSON', () => {
    const { result } = run(new ToolResultPrunerModule(on()), '{\n  "status": "ok",\n  "items": [\n    1,\n    2\n  ]\n}\n')
    expect(result).toBe('{"status":"ok","items":[1,2]}')
  })

  it('trims trailing whitespace but keeps interior runs and indentation by default', () => {
    const fileRead = '     1\tdef f(x):   \n     2\t    return  x\t\n'
    expect(run(new ToolResultPrunerModule(on()), fileRead).result).toBe('     1\tdef f(x):\n     2\t    return  x\n')
  })

  it('collapses interior runs only when asked, keeping leading indentation', () => {
    const table = 'NAME      STATUS    AGE\nweb-1     Running   3d\n  indented   line'
    expect(run(new ToolResultPrunerModule(on({ collapseSpaceRuns: true })), table).result)
      .toBe('NAME STATUS AGE\nweb-1 Running 3d\n  indented line')
  })

  it('applies each technique only when its option is on', () => {
    const pretty = '{\n  "a": 1\n}  '
    expect(run(new ToolResultPrunerModule(on({ minifyJson: false, trimTrailing: false })), pretty).result).toBe(pretty)
    expect(run(new ToolResultPrunerModule(on({ minifyJson: false })), pretty).result).toBe('{\n  "a": 1\n}')
  })

  it('never touches prompt text', () => {
    expect(run(new ToolResultPrunerModule(on({ collapseSpaceRuns: true })), 'x  ').prompt).toBe('keep   this')
  })

  it('covers OpenAI tool messages and Responses API function_call_output', () => {
    const mod = new ToolResultPrunerModule(on())
    const body = JSON.stringify({
      messages: [{ role: 'tool', tool_call_id: 'c', content: '{ "a" : 1 }' }],
      input: [{ type: 'function_call_output', call_id: 'd', output: '[ 1, 2 ]' }],
    })
    const parsed = JSON.parse(mod.transformRequest(body, ctx).body)
    expect(parsed.messages[0].content).toBe('{"a":1}')
    expect(parsed.input[0].output).toBe('[1,2]')
  })

  it('reads its options live', () => {
    const cfg = on({ minifyJson: false, trimTrailing: false })
    const mod = new ToolResultPrunerModule(cfg)
    expect(mod.transformRequest(toolResult('{ "a": 1 }'), ctx).modified).toBe(false)
    cfg.minifyJson = true
    expect(mod.transformRequest(toolResult('{ "a": 1 }'), ctx).modified).toBe(true)
  })
})
