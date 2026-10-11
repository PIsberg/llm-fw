import { describe, it, expect } from 'vitest'
import { applyIdeProxy } from '../../src/cli/setup.js'
import { removeIdeProxy } from '../../src/cli/uninstall.js'

/**
 * `setup` adds http.proxy to the user's VS Code / Antigravity settings.json and
 * `uninstall` takes it out again. Both used to re-serialize the whole file with
 * JSON.stringify(_, null, 4), so a setup/uninstall round trip left a 2-space,
 * no-trailing-newline file permanently re-indented. Found on a live install.
 * The round trip must leave the file byte-identical.
 */
const PROXY = 'http://127.0.0.1:8080'

function roundTrip(original: string): string {
  const applied = applyIdeProxy(original, PROXY)
  expect(applied.kind).toBe('updated')
  const content = applied.kind === 'updated' ? applied.content : original
  expect(JSON.parse(content)['http.proxy']).toBe(PROXY)
  return removeIdeProxy(content) ?? content
}

describe('IDE settings.json round trip', () => {
  it('restores a 2-space, LF, no-trailing-newline file byte for byte', () => {
    const original = '{\n  "chat.mcp.enabled": true,\n  "tools": [\n    "a",\n    "b"\n  ]\n}'
    expect(roundTrip(original)).toBe(original)
  })

  it('restores a tab-indented CRLF file with a trailing newline byte for byte', () => {
    const original = '{\r\n\t"editor.fontSize": 14,\r\n\t"nested": {\r\n\t\t"x": 1\r\n\t}\r\n}\r\n'
    expect(roundTrip(original)).toBe(original)
  })

  it('keeps the file\'s own indentation while the proxy is set', () => {
    const applied = applyIdeProxy('{\n  "a": 1\n}\n', PROXY)
    expect(applied).toEqual({ kind: 'updated', content: `{\n  "a": 1,\n  "http.proxy": "${PROXY}"\n}\n` })
  })

  it('leaves a proxy the user configured themselves untouched', () => {
    // llm-fw cannot chain to an upstream proxy, so replacing a corporate one
    // would cut the IDE off, and uninstall would then delete it outright.
    const original = '{\n  "http.proxy": "http://proxy.corp.example.com:3128"\n}'
    expect(applyIdeProxy(original, PROXY)).toEqual({ kind: 'foreign-proxy', proxy: 'http://proxy.corp.example.com:3128' })
    expect(removeIdeProxy(original)).toBeNull()
  })

  it('does not rewrite a settings file with comments (JSONC)', () => {
    const original = '{\n  // font\n  "editor.fontSize": 14\n}'
    expect(applyIdeProxy(original, PROXY)).toEqual({ kind: 'unparseable' })
    expect(removeIdeProxy(original)).toBeNull()
  })

  it('reports no change when the proxy is already set', () => {
    expect(applyIdeProxy(`{\n  "http.proxy": "${PROXY}"\n}`, PROXY)).toEqual({ kind: 'unchanged' })
  })
})
