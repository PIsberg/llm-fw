import { describe, it, expect } from 'vitest'
import { ModuleManager } from '../../src/modules/registry.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import type { Config } from '../../src/types.js'

// Slice S1 of the tool result shunt: the config key and the registration.
// specs/001-tool-result-shunt/data-model.md "Config" is the table asserted
// here. test/modules/builtins.test.ts already walks BUILTINS for the
// LLM_FW_TOOL_RESULT_SHUNT_ENABLED switch and the warm options (US4-2, US4-5).

describe('modules.toolResultShunt defaults', () => {
  const shunt = () => DEFAULT_CONFIG.modules!.toolResultShunt!

  it('is off by default (FR-001, US4-1)', () => {
    expect(shunt().enabled).toBe(false)
  })

  it('carries the size thresholds and limits of data-model.md "Config" (FR-002, FR-008, FR-024, FR-025)', () => {
    const { enabled: _enabled, tools: _tools, ...options } = shunt()
    expect(options).toEqual({
      minLines: 350,
      minChars: 20000,
      maxInputChars: 200000,
      waitMs: 15000,
      workerUrl: '',
      workerModel: '',
      retentionHours: 24,
      maxStoreMB: 200,
    })
  })

  it('names no worker until the operator sets one (FR-011)', () => {
    expect(shunt().workerUrl).toBe('')
    expect(shunt().workerModel).toBe('')
  })

  it('lists the eligible tools of data-model.md "Config" (FR-003)', () => {
    expect([...shunt().tools].sort()).toEqual([
      'Bash', 'BashOutput', 'Glob', 'Grep', 'LS', 'PowerShell',
      'exec_command', 'glob', 'list_directory', 'run_shell_command', 'search_file_content', 'shell',
    ].sort())
  })

  it('shares no tool name with the truncator skipTools, so no file-reading tool is eligible (FR-003, US1-7)', () => {
    const skip = DEFAULT_CONFIG.modules!.toolResultTruncate!.skipTools
    expect(skip.length).toBeGreaterThan(0)
    const shared = shunt().tools.filter(name => skip.includes(name))
    expect(shared).toEqual([])
    // The same check the module will make: a name ending in `__` plus a skipped name is a file read too.
    const mcpShared = shunt().tools.filter(name => skip.some(s => name.endsWith(`__${s}`)))
    expect(mcpShared).toEqual([])
  })

  it('has no duplicate tool names', () => {
    const { tools } = shunt()
    expect(new Set(tools).size).toBe(tools.length)
  })
})

describe('ModuleManager registration of the tool result shunt', () => {
  it('registers tool-result-shunt, disabled (US4-1)', () => {
    const mod = new ModuleManager(structuredClone(DEFAULT_CONFIG) as Config).getModule('tool-result-shunt')
    expect(mod).toBeDefined()
    expect(mod!.id).toBe('tool-result-shunt')
    expect(mod!.name).toBe('Tool Result Shunt')
    expect(mod!.enabled).toBe(false)
  })

  it('registers it disabled when the manager is built without a config (US4-1)', () => {
    const mod = new ModuleManager().getModule('tool-result-shunt')
    expect(mod).toBeDefined()
    expect(mod!.enabled).toBe(false)
  })

  it('creates the config slot from the defaults for a config that predates it, and hands the module that live slot (US4-2)', () => {
    const config = { ...structuredClone(DEFAULT_CONFIG), modules: { enabled: true, tokenPruner: { enabled: true } } } as unknown as Config
    const mgr = new ModuleManager(config)
    const slot = config.modules!.toolResultShunt
    expect(slot).toEqual(DEFAULT_CONFIG.modules!.toolResultShunt)
    // Flipping the live slot reaches the running module without a restart.
    slot!.enabled = true
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(true)
  })

  it('is switched on and off through the manager, as the dashboard does (FR-001, US4-2)', () => {
    const mgr = new ModuleManager(structuredClone(DEFAULT_CONFIG) as Config)
    expect(mgr.setModuleEnabled('tool-result-shunt', true)).toBe(true)
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(true)
    expect(mgr.setModuleEnabled('tool-result-shunt', false)).toBe(true)
    expect(mgr.getModule('tool-result-shunt')!.enabled).toBe(false)
  })
})
