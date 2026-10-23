import { describe, it, expect } from 'vitest'
import { ToolResultPrunerModule, collapseLibraryStackFrames, groupFileMatches } from '../../src/modules/builtin/toolResultPruner.js'
import { minifyJsonText } from '../../src/modules/json.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const on = (extra: Record<string, boolean> = {}) => ({ enabled: true, minifyJson: true, trimTrailing: true, collapseSpaceRuns: false, collapseStackFrames: false, ...extra })
const toolResult = (content: string) => JSON.stringify({
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }, { type: 'text', text: 'keep   this' }] }],
})
const run = (mod: ToolResultPrunerModule, content: string) => {
  const parsed = JSON.parse((mod.transformRequest(toolResult(content), ctx) as { body: string }).body)
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

  it('trims in one pass, however long an interior run of spaces is', () => {
    // [ \t]+(?=\r?\n|$) restarted at every space of a run that does not end
    // the line: 3,052 ms for one 40,000-space run.
    const line = 'x' + ' '.repeat(40_000) + 'y'
    const t0 = performance.now()
    expect(run(new ToolResultPrunerModule(on({ minifyJson: false })), line + ' \r\n' + line).result).toBe(line + '\r\n' + line)
    expect(performance.now() - t0).toBeLessThan(500)
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
    const parsed = JSON.parse((mod.transformRequest(body, ctx) as { body: string }).body)
    expect(parsed.messages[0].content).toBe('{"a":1}')
    expect(parsed.input[0].output).toBe('[1,2]')
  })

  it('reads its options live', () => {
    const cfg = on({ minifyJson: false, trimTrailing: false })
    const mod = new ToolResultPrunerModule(cfg)
    expect((mod.transformRequest(toolResult('{ "a": 1 }'), ctx) as { modified: boolean }).modified).toBe(false)
    cfg.minifyJson = true
    expect((mod.transformRequest(toolResult('{ "a": 1 }'), ctx) as { modified: boolean }).modified).toBe(true)
  })

  it('collapses contiguous node_modules and node:internal stack frames while keeping app frames', () => {
    const trace = [
      'Error: boom',
      '    at Object.run (src/app.ts:12:5)',
      '    at Runner.exec (/repo/node_modules/vitest/dist/chunks/runner.js:100:12)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      '    at async Promise.all (index 0)',
      '    at main (src/index.ts:4:1)',
    ].join('\n')
    const out = collapseLibraryStackFrames(trace)
    expect(out).toBe([
      'Error: boom',
      '    at Object.run (src/app.ts:12:5)',
      '    [llm-fw: 2 internal/library stack frames elided]',
      '    at async Promise.all (index 0)',
      '    at main (src/index.ts:4:1)',
    ].join('\n'))
  })

  it('elides library stack frames only when collapseStackFrames is on', () => {
    // The elided frames cannot be recovered without rerunning the command, so
    // the module's default, and its constructor's, keeps them.
    const trace = [
      'Error: boom',
      '    at Runner.exec (/repo/node_modules/vitest/dist/chunks/runner.js:100:12)',
      '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
    ].join('\n')
    expect(run(new ToolResultPrunerModule(on()), trace).result).toBe(trace)
    const bare = new ToolResultPrunerModule()
    bare.enabled = true
    expect(run(bare, trace).result).toBe(trace)
    expect(run(new ToolResultPrunerModule({ ...DEFAULT_CONFIG.modules!.toolResultPruner!, enabled: true }), trace).result).toBe(trace)
    expect(run(new ToolResultPrunerModule(on({ collapseStackFrames: true })), trace).result)
      .toBe('Error: boom\n    [llm-fw: 2 internal/library stack frames elided]')
  })

  it('groups contiguous grep/compiler file:line:content matches under a single file header and keeps every match', () => {
    const grepOut = [
      'src/modules/builtin/toolResultPruner.ts:10:const a = 1',
      'src/modules/builtin/toolResultPruner.ts:25:const b = 2',
      'src/modules/builtin/toolResultPruner.ts:30:const c = 3',
      'src/other.ts:5:const x = 9',
    ].join('\n')
    expect(groupFileMatches(grepOut)).toBe([
      'src/modules/builtin/toolResultPruner.ts:',
      '  10:const a = 1',
      '  25:const b = 2',
      '  30:const c = 3',
      'src/other.ts:5:const x = 9',
    ].join('\n'))

    // Grouping is lossless: a match dropped here could only come back by
    // rerunning the search.
    const many = Array.from({ length: 55 }, (_, i) => `dist/bundle.js:${i + 1}:var x=${i}`).join('\n')
    const grouped = groupFileMatches(many).split('\n')
    expect(grouped[0]).toBe('dist/bundle.js:')
    expect(grouped).toHaveLength(56)
    expect(grouped[55]).toBe('  55:var x=54')
  })

  it('groups paths without an extension and Windows separators', () => {
    expect(groupFileMatches('docker/Dockerfile:1:FROM node\ndocker/Dockerfile:3:RUN npm ci')).toBe('docker/Dockerfile:\n  1:FROM node\n  3:RUN npm ci')
    expect(groupFileMatches('src\\a.ts:1:x\r\nsrc\\a.ts:2:y\r\n')).toBe('src\\a.ts:\r\n  1:x\r\n  2:y\r\n')
  })

  it('leaves log lines whose prefix is not a file path alone', () => {
    // ISO timestamps split as `2026-10-06T16` `:57:` `25...`.
    const stamped = [
      '2026-10-06T16:57:25.1234567Z ##[group]Run npm ci',
      '2026-10-06T16:57:26.0000000Z added 812 packages',
    ].join('\n')
    expect(groupFileMatches(stamped)).toBe(stamped)
    // `gh run view --log`: job, step and timestamp, tab-separated.
    const ghLog = [
      'test (22)\tRun tests\t2026-10-06T16:57:25.1Z  ✓ test/a.test.ts',
      'test (22)\tRun tests\t2026-10-06T16:57:25.2Z  ✓ test/b.test.ts',
    ].join('\n')
    expect(groupFileMatches(ghLog)).toBe(ghLog)
    const clock = 'build 12:30:01 started\nbuild 12:30:02 done'
    expect(groupFileMatches(clock)).toBe(clock)
  })
})
