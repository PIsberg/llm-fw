import { describe, it, expect, beforeAll } from 'vitest'
import fs from 'node:fs'
import { trustedReadPath } from '../../src/detection/trustedPaths.js'
import { Pipeline } from '../../src/detection/pipeline.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

const ROOTS = ['/home/dev/projects', 'C:\\dev\\private']

describe('trustedReadPath', () => {
  it('trusts a file read under a configured root', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/game/src/ai.gd' }, ROOTS)).toBe('/home/dev/projects/game/src/ai.gd')
    expect(trustedReadPath('read_file', { absolute_path: '/home/dev/projects/README.md' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('read_text_file', { path: '/home/dev/projects/a.txt' }, ROOTS)).not.toBeNull()
  })

  it('matches Windows paths whatever the separator and drive-letter case', () => {
    expect(trustedReadPath('Read', { file_path: 'C:\\dev\\private\\llm-fw\\docs\\FALSE-POSITIVES.md' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('Read', { file_path: 'c:/Dev/Private/llm-fw/CHANGELOG.md' }, ROOTS)).not.toBeNull()
  })

  it('does not read a Git-Bash /c/... path as a drive path (#439)', () => {
    // Whether /c/dev/x means C:\dev\x depends on the client: Claude Code
    // translates it, but Node's own fs on Windows resolves it to C:\c\dev\x,
    // a different file. Trusting it would vouch for whichever one was read.
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/llm-fw/README.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/C/Dev/Private/a.md' }, ROOTS)).toBeNull()
    // Against a POSIX root it is the POSIX path it reads as.
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/a.md' }, ['/c/dev'])).not.toBeNull()
  })

  it('reads a known MCP file server and arguments sent as a JSON string', () => {
    expect(trustedReadPath('mcp__lean-ctx__ctx_read', { path: '/home/dev/projects/a.ts' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('mcp__filesystem__read_text_file', { path: '/home/dev/projects/a.ts' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('read_file', JSON.stringify({ path: '/home/dev/projects/a.ts' }), ROOTS)).not.toBeNull()
  })

  it('does not trust a read tool on any other MCP server: it may be serving fetched content', () => {
    expect(trustedReadPath('mcp__web__read_file', { path: '/home/dev/projects/a.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('mcp__evil__lean-ctx__ctx_read', { path: '/home/dev/projects/a.ts' }, ROOTS)).toBeNull()
    expect(trustedReadPath('mcp__a__b__read_file', { path: '/home/dev/projects/a.ts' }, ROOTS)).toBeNull()
  })

  it('trusts a call only when every path argument it carries is under a root', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/a.md', path: '/tmp/evil.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { path: '/tmp/evil.md', file_path: '/home/dev/projects/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/a.md', path: '' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/a.md', path: '/home/dev/projects/b.md' }, ROOTS)).not.toBeNull()
  })

  it('does not trust a path outside every root, or one that only shares a prefix', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/downloads/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects-evil/a.md' }, ROOTS)).toBeNull()
  })

  it('does not trust a path that climbs out of the root', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/../downloads/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: 'C:\\dev\\private\\..\\Users\\me\\Downloads\\a.md' }, ROOTS)).toBeNull()
  })

  it('does not trust Windows path spellings it cannot resolve lexically', () => {
    for (const p of [
      // 8.3 short names: NODE_M~1 is node_modules on disk.
      'C:\\dev\\private\\app\\NODE_M~1\\pkg\\README.md',
      'C:\\dev\\PRIVAT~1\\app\\README.md',
      // Alternate data streams name the same directory or file.
      'C:\\dev\\private\\app\\node_modules::$INDEX_ALLOCATION\\pkg\\README.md',
      'C:\\dev\\private\\app\\README.md:hidden',
      // Device and long-path prefixes.
      '\\\\?\\C:\\dev\\private\\app\\README.md',
      '\\\\.\\C:\\dev\\private\\app\\README.md',
    ]) expect(trustedReadPath('Read', { file_path: p }, ROOTS), p).toBeNull()
  })

  it('does not trust a relative path: the proxy cannot know what it is relative to', () => {
    expect(trustedReadPath('Read', { file_path: 'src/a.ts' }, ROOTS)).toBeNull()
  })

  it('does not trust third-party code inside a trusted root', () => {
    for (const p of [
      '/home/dev/projects/app/node_modules/pkg/README.md',
      '/home/dev/projects/app/vendor/lib/x.go',
      '/home/dev/projects/app/.venv/lib/python3.12/site-packages/x/README.md',
      'C:\\dev\\private\\app\\third_party\\x.h',
      '/home/dev/projects/app/.git/COMMIT_EDITMSG',
      // Case-insensitive file systems (Windows, macOS) and Windows dropping
      // a trailing dot or space resolve these to the same directories.
      '/home/dev/projects/app/Node_Modules/pkg/README.md',
      'C:\\dev\\private\\app\\VENDOR\\x.go',
      'C:\\dev\\private\\app\\node_modules.\\pkg\\README.md',
      'C:\\dev\\private\\app\\vendor \\x.go',
    ]) expect(trustedReadPath('Read', { file_path: p }, ROOTS), p).toBeNull()
  })

  it('trusts only file-read tools: fetch, write and non-read shell output stay untrusted', () => {
    expect(trustedReadPath('Bash', { command: 'git show HEAD:a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('WebFetch', { url: 'https://example.com', path: '/home/dev/projects/a' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Write', { file_path: '/home/dev/projects/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath(undefined, { file_path: '/home/dev/projects/a.md' }, ROOTS)).toBeNull()
  })

  it('trusts nothing with no roots configured', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/a.md' }, [])).toBeNull()
  })

  it('trusts a Grep or Glob of a directory under a root, or of the root itself', () => {
    expect(trustedReadPath('Grep', { pattern: 'NO_PROXY', path: 'C:\\dev\\private\\llm-fw\\src\\cli', output_mode: 'content' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('Grep', { pattern: 'x', path: '/home/dev/projects' }, ROOTS)).not.toBeNull()
    expect(trustedReadPath('Glob', { pattern: '**/*.ts', path: '/home/dev/projects/game' }, ROOTS)).not.toBeNull()
  })

  it('does not trust a search without a path, outside every root, or of a third-party directory', () => {
    // Without a path the tool searches a working directory the call does not name.
    expect(trustedReadPath('Grep', { pattern: 'x' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Grep', { pattern: 'x', path: '/tmp' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Grep', { pattern: 'x', path: '/home/dev/projects/game/node_modules' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Glob', { pattern: '*', path: '/home/dev/projects/game/vendor/lib' }, ROOTS)).toBeNull()
    // Only a search may name the root itself: a file read of a directory reads nothing.
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects' }, ROOTS)).toBeNull()
  })
})

// The real stages, not mocks: llm-fw's own detection guide quotes dozens of
// attacks verbatim and is refused when an agent reads it (#349).
// A first scan of a 30 KB document takes seconds, not the 5 s default's
// fraction of it, when the rest of the suite shares the CPU.
describe('trusted paths through the real pipeline', () => {
  const META = { target: 'eval', method: 'POST', path: '/v1/messages' }
  const guide = fs.readFileSync(new URL('../../docs/guides/detection-stages.md', import.meta.url), 'utf8')
  const readOf = (toolName: string, input: Record<string, unknown>, content: string) => JSON.stringify({
    messages: [
      { role: 'user', content: 'Summarise the detection guide.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: toolName, input }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content }] },
    ],
  })
  const trusting = () => ({
    ...DEFAULT_CONFIG,
    detection: { ...DEFAULT_CONFIG.detection, surfaces: { tool_result: { trustedPaths: ['/home/dev/projects'] } } },
  })
  let plain: Pipeline
  let trusted: Pipeline

  beforeAll(async () => {
    plain = new Pipeline(DEFAULT_CONFIG)
    trusted = new Pipeline(trusting())
    await Promise.all([plain.init(), trusted.init()])
  }, 120_000)

  it('blocks the guide by default', async () => {
    const body = readOf('Read', { file_path: '/home/dev/projects/llm-fw/docs/guides/detection-stages.md' }, guide)
    expect((await plain.run('/v1/messages', body, META)).action).toBe('block')
  }, 60_000)

  it('warns instead when the guide was read from a trusted root', async () => {
    const body = readOf('Read', { file_path: '/home/dev/projects/llm-fw/docs/guides/detection-stages.md' }, guide)
    expect((await trusted.run('/v1/messages', body, META)).action).toBe('warn')
  }, 60_000)

  it('still blocks the same text read from outside the root, or printed by a shell command that is not a plain read', async () => {
    const outside = readOf('Read', { file_path: '/tmp/detection-stages.md' }, guide)
    const shell = readOf('Bash', { command: 'git show HEAD:docs/guides/detection-stages.md' }, guide)
    expect((await trusted.run('/v1/messages', outside, META)).action).toBe('block')
    expect((await trusted.run('/v1/messages', shell, META)).action).toBe('block')
  }, 60_000)

  it('warns instead when a plain cat printed the guide from under the root (#437)', async () => {
    const shell = readOf('Bash', { command: 'cat /home/dev/projects/llm-fw/docs/guides/detection-stages.md' }, guide)
    expect((await trusted.run('/v1/messages', shell, META)).action).toBe('warn')
  }, 60_000)

  it('warns instead when Grep found the text under the root', async () => {
    const grep = readOf('Grep', { pattern: 'ignore', path: '/home/dev/projects/llm-fw/docs', output_mode: 'content' }, guide)
    expect((await trusted.run('/v1/messages', grep, META)).action).toBe('warn')
  }, 60_000)

  // Claude Code through the proxy continues a server-side thread: the request
  // carries the tool result, and the call it answers was in the response
  // before it. The pipeline learns the call from that response.
  it('reads a thread continuation\'s result with the call learned from the response before it', async () => {
    const pipeline = new Pipeline(trusting())
    await pipeline.init()
    const continuation = JSON.stringify({
      thread: { type: 'continue', previous_message_id: 'msg_1' },
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_thread', content: guide }] }],
    })
    expect((await pipeline.run('/v1/messages', continuation, META)).action).toBe('block')
    pipeline.learnCalls({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({
        id: 'msg_1', type: 'message', role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_thread', name: 'Read', input: { file_path: '/home/dev/projects/llm-fw/docs/guides/detection-stages.md' } }],
      })),
    })
    expect((await pipeline.run('/v1/messages', continuation, META)).action).toBe('warn')
  }, 120_000)

  it('learns a call only for its own id, and only when a root is configured', async () => {
    const pipeline = new Pipeline(trusting())
    await pipeline.init()
    pipeline.learnCalls({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: '/home/dev/projects/a.md' } }] })),
    })
    const other = JSON.stringify({
      thread: { type: 'continue', previous_message_id: 'msg_1' },
      messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fetch', content: guide }] }],
    })
    expect((await pipeline.run('/v1/messages', other, META)).action).toBe('block')
    expect(new Pipeline(DEFAULT_CONFIG).wantsCalls()).toBe(false)
    expect(pipeline.wantsCalls()).toBe(true)
  }, 120_000)
})
