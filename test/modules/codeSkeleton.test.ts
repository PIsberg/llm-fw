import { describe, it, expect } from 'vitest'
import { CodeSkeletonModule, skeletonize, languageOf } from '../../src/modules/builtin/codeSkeleton.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { underMs, LINEAR_TIME_TIMEOUT } from '../linearTime.js'

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
const lines = (...l: string[]) => l.join('\n')
// The marker for an elided range, at the indentation of the first line it replaces.
const marker = (indent: string, from: number, to: number) => `${indent}[llm-fw: lines ${from}-${to} elided, read that range for the body]`
// Claude Code's Read format: a right-aligned line number, a tab, the line.
const numbered = (text: string) => text.split('\n').map((l, i) => `${String(i + 1).padStart(6)}\t${l}`).join('\n')

const TS = lines(
  "import { Pool } from 'pg'",           // 1
  '',                                     // 2
  'export interface Row {',               // 3
  '  id: string',                         // 4
  '  load(): { a: number; b: number }',   // 5
  '}',                                    // 6
  '',                                     // 7
  '/** Talks to the database. */',        // 8
  'export class Db {',                    // 9
  '  constructor(private url: string) {', // 10
  '    this.pool = new Pool({ url })',    // 11
  '    this.pool.on("error", e => {',     // 12
  '      console.error("}", e)',          // 13
  '    })',                               // 14
  '  }',                                  // 15
  '',                                     // 16
  '  async query<T>(sql: string): Promise<T[]> {', // 17
  '    const c = await this.pool.connect()', // 18
  '    try {',                            // 19
  '      return (await c.query(sql)).rows', // 20
  '    } finally {',                      // 21
  '      c.release()',                    // 22
  '    }',                                // 23
  '  }',                                  // 24
  '',                                     // 25
  '  get size(): number { return 1 }',   // 26
  '}',                                    // 27
  '',                                     // 28
  'export const handler = async (req: Req) => {', // 29
  '  const a = 1',                        // 30
  '  const b = 2',                        // 31
  '  const c = 3',                        // 32
  '  return a + b + c',                   // 33
  '}',                                    // 34
)

describe('skeletonize, brace languages', () => {
  it('replaces long function bodies with a marker naming their lines, and keeps every signature', () => {
    expect(skeletonize(TS, 'js', 3)).toBe(lines(
      "import { Pool } from 'pg'",
      '',
      'export interface Row {',
      '  id: string',
      '  load(): { a: number; b: number }',
      '}',
      '',
      '/** Talks to the database. */',
      'export class Db {',
      '  constructor(private url: string) {',
      marker('    ', 11, 14),
      '  }',
      '',
      '  async query<T>(sql: string): Promise<T[]> {',
      marker('    ', 18, 23),
      '  }',
      '',
      '  get size(): number { return 1 }',
      '}',
      '',
      'export const handler = async (req: Req) => {',
      marker('  ', 30, 33),
      '}',
    ))
  })

  it('keeps a body shorter than minBodyLines whole', () => {
    const out = skeletonize(TS, 'js', 5).split('\n')
    expect(out).toContain('  const a = 1')
    expect(out).toContain('    this.pool = new Pool({ url })')
    expect(out).toContain(marker('    ', 18, 23))
  })

  it('takes line numbers from a numbered read and keeps each kept line as it was', () => {
    const out = skeletonize(numbered(TS), 'js', 3).split('\n')
    expect(out).toContain('    17\t  async query<T>(sql: string): Promise<T[]> {')
    expect(out).toContain(marker('    ', 18, 23))
    expect(out).toContain('    24\t  }')
    expect(out).not.toContain('    20\t      return (await c.query(sql)).rows')
  })

  it('is not thrown off by braces in strings, templates, comments and regex literals', () => {
    const code = lines(
      'function a() {',           // 1
      "  const s = '}}}'",        // 2
      // biome-ignore lint/suspicious/noTemplateCurlyInString: source text holding a template literal
      '  const t = `${x}}}${"{"}`', // 3
      '  // }}}',                 // 4
      '  /* } */ const r = /\\}+/g', // 5
      '  return s + t',           // 6
      '}',                        // 7
      'function b() {',           // 8
      '  one()',                  // 9
      '  two()',                  // 10
      '  three()',                // 11
      '}',                        // 12
    )
    expect(skeletonize(code, 'js', 3)).toBe(lines(
      'function a() {', marker('  ', 2, 6), '}',
      'function b() {', marker('  ', 9, 11), '}',
    ))
  })

  it('leaves control blocks and callbacks at the top level whole', () => {
    const code = lines(
      "describe('x', () => {",
      "  it('y', () => {",
      '    expect(1).toBe(1)',
      '    expect(2).toBe(2)',
      '    expect(3).toBe(3)',
      '  })',
      '})',
      'if (ready) {',
      '  a()',
      '  b()',
      '  c()',
      '}',
    )
    expect(skeletonize(code, 'js', 2)).toBe(code)
  })

  it('leaves text whose braces do not balance unchanged', () => {
    const cut = TS.split('\n').slice(0, 20).join('\n')
    expect(skeletonize(cut, 'js', 3)).toBe(cut)
  })

  it('handles Go methods with multiple returns and Rust lifetimes', () => {
    const go = lines(
      'func (s *Store) Get(id string) (*Row, error) {',
      '\trow, err := s.db.Find(id)',
      '\tif err != nil {',
      '\t\treturn nil, err',
      '\t}',
      '\treturn row, nil',
      '}',
    )
    expect(skeletonize(go, 'c', 3)).toBe(lines(go.split('\n')[0]!, marker('\t', 2, 6), '}'))

    const rust = lines(
      "impl<'a> Parser<'a> {",
      "    pub fn next(&mut self) -> Option<&'a str> {",
      "        let c = '{';",
      '        self.pos += 1;',
      '        None',
      '    }',
      '}',
    )
    expect(skeletonize(rust, 'rust', 3)).toBe(lines(
      "impl<'a> Parser<'a> {",
      "    pub fn next(&mut self) -> Option<&'a str> {",
      marker('        ', 3, 5),
      '    }',
      '}',
    ))
  })
})

describe('skeletonize, Python', () => {
  it('elides def bodies, keeps the docstring, decorators, classes and module code', () => {
    const py = lines(
      'import os',                   // 1
      '',                            // 2
      'class Store:',                // 3
      '    @cached',                 // 4
      '    def get(self, key: str) -> str:', // 5
      '        """Return the value."""', // 6
      '        path = os.path.join(self.root, key)', // 7
      '        with open(path) as f:', // 8
      '            data = f.read()',   // 9
      '        return data',           // 10
      '',                            // 11
      '    def put(',                // 12
      '        self, key: str,',     // 13
      '        value: str,',         // 14
      '    ) -> None:',              // 15
      '        text = """',          // 16
      'def not_a_function():',       // 17
      '"""',                         // 18
      '        self.write(key, text + value)', // 19
      '',                            // 20
      'ROOT = "/tmp"',               // 21
    )
    expect(skeletonize(py, 'python', 3)).toBe(lines(
      'import os',
      '',
      'class Store:',
      '    @cached',
      '    def get(self, key: str) -> str:',
      '        """Return the value."""',
      marker('        ', 7, 10),
      '',
      '    def put(',
      '        self, key: str,',
      '        value: str,',
      '    ) -> None:',
      marker('        ', 16, 19),
      '',
      'ROOT = "/tmp"',
    ))
  })
})

describe('languageOf', () => {
  it('knows the languages by extension, and nothing else', () => {
    expect(languageOf('src/a.ts')).toBe('js')
    expect(languageOf('web/App.tsx')).toBe('js')
    expect(languageOf('C:\\x\\Main.JAVA')).toBe('c')
    expect(languageOf('cmd/main.go')).toBe('c')
    expect(languageOf('lib/x.rs')).toBe('rust')
    expect(languageOf('app.py')).toBe('python')
    expect(languageOf('README.md')).toBeUndefined()
    expect(languageOf('data.json')).toBeUndefined()
    expect(languageOf('Makefile')).toBeUndefined()
  })
})

describe('CodeSkeletonModule', () => {
  const cfg = () => ({ ...structuredClone(DEFAULT_CONFIG.modules!.codeSkeleton!), enabled: true, minLines: 10, minBodyLines: 3 })
  const send = (mod: CodeSkeletonModule, payload: unknown) => JSON.parse(mod.transformRequest(JSON.stringify(payload), ctx).body)
  const read = (name: string, input: unknown, content = numbered(TS)) => ({ messages: [
    { role: 'user', content: 'look' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name, input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
  ] })
  const result = (out: { messages: Array<{ content: Array<{ content: string }> }> }) => out.messages[2]!.content[0]!.content
  const isSkeleton = (text: string) => text.includes('elided, read that range for the body]')

  it('is off by default', () => {
    expect(DEFAULT_CONFIG.modules!.codeSkeleton!.enabled).toBe(false)
  })

  it('shortens a whole-file read of a code file and counts the saving', () => {
    const mod = new CodeSkeletonModule(cfg())
    const out = result(send(mod, read('Read', { file_path: 'src/db.ts' })))
    expect(out).toBe(skeletonize(numbered(TS), 'js', 3))
    expect(mod.getStats().tokensSaved).toBeGreaterThan(0)
  })

  it('leaves a partial read, a non-code file, a short file and another tool whole', () => {
    const mod = new CodeSkeletonModule(cfg())
    expect(result(send(mod, read('Read', { file_path: 'src/db.ts', offset: 10, limit: 30 })))).toBe(numbered(TS))
    expect(result(send(mod, read('read_text_file', { path: 'src/db.ts', head: 40 })))).toBe(numbered(TS))
    expect(result(send(mod, read('Read', { file_path: 'notes.md' })))).toBe(numbered(TS))
    expect(result(send(mod, read('Bash', { command: 'cat src/db.ts' })))).toBe(numbered(TS))
    const short = numbered(TS.split('\n').slice(28).join('\n'))
    expect(result(send(new CodeSkeletonModule({ ...cfg(), minLines: 40 }), read('Read', { file_path: 'src/db.ts' })))).toBe(numbered(TS))
    expect(result(send(mod, read('Read', { file_path: 'src/db.ts' }, short)))).toBe(short)
  })

  it('reads lean-ctx ctx_read only in full mode, and matches an MCP tool by its suffix', () => {
    const mod = new CodeSkeletonModule(cfg())
    expect(isSkeleton(result(send(mod, read('mcp__lean-ctx__ctx_read', { path: 'a.ts', mode: 'full' }))))).toBe(true)
    expect(result(send(mod, read('mcp__lean-ctx__ctx_read', { path: 'a.ts', mode: 'signatures' })))).toBe(numbered(TS))
    expect(result(send(mod, read('mcp__lean-ctx__ctx_read', { path: 'a.ts', mode: 'lines:1-40' })))).toBe(numbered(TS))
    expect(result(send(mod, read('mcp__lean-ctx__preread', { path: 'a.ts' })))).toBe(numbered(TS))
  })

  it('takes tools and thresholds live', () => {
    const live = cfg()
    const mod = new CodeSkeletonModule(live)
    expect(isSkeleton(result(send(mod, read('Read', { file_path: 'a.ts' }))))).toBe(true)
    live.tools = []
    expect(result(send(mod, read('Read', { file_path: 'a.ts' })))).toBe(numbered(TS))
    live.tools = ['Read']
    live.minBodyLines = 100
    expect(result(send(mod, read('Read', { file_path: 'a.ts' })))).toBe(numbered(TS))
  })

  // Claude Code through the proxy continues a server-side thread: the result
  // arrives without the call, which only the previous response named.
  it('learns the call of a thread continuation from the response', () => {
    const mod = new CodeSkeletonModule(cfg())
    const continuation = { thread: { type: 'continue', previous_message_id: 'msg_1' }, messages: [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_r', content: numbered(TS) }] },
    ] }
    // No response seen: the tool is unknown, so the result stays whole.
    expect(send(mod, continuation).messages[0].content[0].content).toBe(numbered(TS))
    mod.observeResponse('{}', ctx, { status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({
      id: 'msg_1', type: 'message', role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_r', name: 'Read', input: { file_path: 'src/db.ts' } }],
    })) })
    expect(isSkeleton(send(mod, continuation).messages[0].content[0].content)).toBe(true)
  })

  // The prompt cache and preserved-thinking signatures both need an earlier
  // turn to come out byte-identical when the conversation grows.
  it('rewrites a turn the same way when later turns are appended', () => {
    const mod = new CodeSkeletonModule(cfg())
    const first = read('Read', { file_path: 'a.ts' })
    const grown = { messages: [...first.messages,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
    ] }
    expect(result(send(mod, grown))).toBe(result(send(mod, first)))
  })
})

// Tool results are attacker-controlled (a cloned repository's file), and the
// module runs on the thread that serves every request.
describe('skeletonize runs in linear time', () => {
  const huge = 200_000
  const shapes: Array<[string, string]> = [
    ['whitespace', ' '.repeat(huge)],
    ['1-', '1-'.repeat(huge / 2)],
    ['base64url', 'aZ0_-'.repeat(huge / 5)],
    ['open parens', 'f('.repeat(huge / 2) + ' {\n'],
    ['open braces', 'f() {\n'.repeat(huge / 6)],
    ['quotes', "'\"`".repeat(huge / 3)],
    ['nested template', '`${'.repeat(huge / 3)],
    ['python defs', 'def f(\n'.repeat(huge / 7)],
    ['short lines', 'x\n'.repeat(huge / 2)],
    ['unclosed regex literals', '(/['.repeat(huge / 3)],
    ['long headers', 'f(a)('.repeat(huge / 5) + ' {}\n'],
  ]
  it.each(shapes)('on 200 KB of %s', { timeout: LINEAR_TIME_TIMEOUT }, (_name, text) => {
    for (const lang of ['js', 'c', 'rust', 'python'] as const) {
      expect(underMs(300, () => skeletonize(text, lang, 3))).toBeLessThan(300)
    }
  })
})
