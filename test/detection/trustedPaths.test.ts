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

  it('matches a Git-Bash /c/... path against a drive root, and only against a drive root (#439)', () => {
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/llm-fw/README.md' }, ROOTS)).toBe('/c/dev/private/llm-fw/README.md')
    expect(trustedReadPath('Read', { file_path: '/C/Dev/Private/a.md' }, ROOTS)).not.toBeNull()
    // On Linux and macOS /c is a real directory: a POSIX root never trusts it
    // as C:, and a drive root does not trust another drive.
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/a.md' }, ['/home/dev/projects'])).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/d/dev/private/a.md' }, ROOTS)).toBeNull()
    // The fail-closed spellings still fail closed in this form.
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/app/NODE_M~1/x.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Read', { file_path: '/c/dev/private/app/node_modules/x.md' }, ROOTS)).toBeNull()
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

  it('trusts only file-read tools: shell, fetch and write output stay untrusted', () => {
    expect(trustedReadPath('Bash', { command: 'cat /home/dev/projects/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath('WebFetch', { url: 'https://example.com', path: '/home/dev/projects/a' }, ROOTS)).toBeNull()
    expect(trustedReadPath('Write', { file_path: '/home/dev/projects/a.md' }, ROOTS)).toBeNull()
    expect(trustedReadPath(undefined, { file_path: '/home/dev/projects/a.md' }, ROOTS)).toBeNull()
  })

  it('trusts nothing with no roots configured', () => {
    expect(trustedReadPath('Read', { file_path: '/home/dev/projects/a.md' }, [])).toBeNull()
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

  it('still blocks the same text read from outside the root, or printed by a shell', async () => {
    const outside = readOf('Read', { file_path: '/tmp/detection-stages.md' }, guide)
    const shell = readOf('Bash', { command: 'cat /home/dev/projects/llm-fw/docs/guides/detection-stages.md' }, guide)
    expect((await trusted.run('/v1/messages', outside, META)).action).toBe('block')
    expect((await trusted.run('/v1/messages', shell, META)).action).toBe('block')
  }, 60_000)
})
