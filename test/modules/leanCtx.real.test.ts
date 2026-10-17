import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { LeanCtxModule } from '../../src/modules/builtin/leanCtx.js'
import type { GatewayModuleContext } from '../../src/modules/types.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'

// Against the real lean-ctx, wherever it is installed: CI installs a pinned
// release (see .github/workflows/ci.yml). leanCtx.test.ts covers the module
// with a stand-in; this pins what the stand-in assumes about lean-ctx.
const binary = process.env.LLM_FW_LEAN_CTX_BIN || 'lean-ctx'
const installed = spawnSync(binary, ['--version'], { encoding: 'utf8' }).status === 0
// Named explicitly (CI does), lean-ctx must be there: a gate that skips
// itself when the install step breaks is not a gate.
const required = Boolean(process.env.LLM_FW_LEAN_CTX_BIN)

it.runIf(required)('finds the lean-ctx that LLM_FW_LEAN_CTX_BIN names', () => {
  expect(installed, `${binary} --version`).toBe(true)
})

const ctx: GatewayModuleContext = { target: 'api.anthropic.com', method: 'POST', path: '/v1/messages', isLlmRequest: true, parser: null }
// A Maven download log, the kind of command output lean-ctx shortens.
const BUILD = [
  '[INFO] Scanning for projects...',
  ...Array.from({ length: 300 }, (_, i) => `[INFO] Downloading from central: https://repo.maven.apache.org/maven2/org/example/lib-${i}/1.0/lib-${i}-1.0.jar`),
  '[INFO] BUILD SUCCESS',
  '[INFO] Total time:  01:36 min',
].join('\n')
const request = JSON.stringify({ messages: [
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'mvn -q verify' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: BUILD }] },
] })

function filesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)])
}

describe.runIf(installed || required)('LeanCtxModule with the real lean-ctx', () => {
  const savedDir = process.env.LLM_FW_DIR
  const modules: LeanCtxModule[] = []
  afterEach(() => {
    for (const mod of modules.splice(0)) mod.close()
    if (savedDir === undefined) delete process.env.LLM_FW_DIR
    else process.env.LLM_FW_DIR = savedDir
  })
  const compressed = async () => {
    const mod = new LeanCtxModule({ ...structuredClone(DEFAULT_CONFIG.modules!.leanCtx!), enabled: true, timeoutMs: 15_000 })
    modules.push(mod)
    const res = await mod.transformRequest(request, ctx)
    return JSON.parse(res.body).messages[1].content[0].content as string
  }

  it('shortens command output, adds no retrieve instruction, and leaves no copy of it on disk', async () => {
    const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-real-'))
    process.env.LLM_FW_DIR = dir
    const out = await compressed()
    expect(out.length).toBeLessThan(BUILD.length / 2)
    expect(out).toContain('BUILD SUCCESS')
    expect(out).not.toMatch(/\[lean-ctx( CCR)?:/)
    expect(fs.statSync(join(dir, 'lean-ctx', 'state', 'tee')).isFile()).toBe(true)
    // lib-137 is a line lean-ctx dropped: nothing it wrote may contain it.
    expect(out).not.toContain('lib-137-1.0.jar')
    for (const file of filesUnder(join(dir, 'lean-ctx'))) {
      expect(fs.readFileSync(file, 'utf8').includes('lib-137-1.0.jar'), file).toBe(false)
    }
  }, 60_000)

  it('gives the same bytes from a freshly started lean-ctx', async () => {
    process.env.LLM_FW_DIR = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-real-'))
    const first = await compressed()
    for (const mod of modules.splice(0)) mod.close()
    process.env.LLM_FW_DIR = fs.mkdtempSync(join(tmpdir(), 'llm-fw-lean-ctx-real-'))
    expect(await compressed()).toBe(first)
  }, 60_000)
})
