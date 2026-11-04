import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PRIOR_ENV_FILE, readPriorEnv, writePriorEnv } from '../../src/cli/setup.js'
import {
  isLlmfwEnvValue,
  recordPriorEnv,
  planEnvRestore,
  parseRegQueryValue,
  type EnvSnapshot,
} from '../../src/cli/userEnv.js'

const LLMFW_PROXY = 'http://127.0.0.1:8080'
const LLMFW_NO_PROXY = 'localhost,127.0.0.1,::1'
const LLMFW_CA_WIN = 'C:\\Users\\isber\\.llm-fw\\ca.crt'

describe('isLlmfwEnvValue', () => {
  it('claims loopback proxy values, on any port', () => {
    expect(isLlmfwEnvValue('HTTPS_PROXY', LLMFW_PROXY)).toBe(true)
    expect(isLlmfwEnvValue('HTTPS_PROXY', 'http://localhost:9090')).toBe(true)
  })

  it('leaves a corporate proxy alone', () => {
    expect(isLlmfwEnvValue('HTTPS_PROXY', 'http://corp-proxy:3128')).toBe(false)
  })

  it('claims the NO_PROXY list setup writes, and not a user list', () => {
    expect(isLlmfwEnvValue('NO_PROXY', LLMFW_NO_PROXY)).toBe(true)
    expect(isLlmfwEnvValue('NO_PROXY', '.mycompany.com')).toBe(false)
  })

  it('claims the CA path under .llm-fw with either path separator', () => {
    expect(isLlmfwEnvValue('NODE_EXTRA_CA_CERTS', LLMFW_CA_WIN)).toBe(true)
    expect(isLlmfwEnvValue('NODE_EXTRA_CA_CERTS', '/home/u/.llm-fw/ca.crt')).toBe(true)
    expect(isLlmfwEnvValue('NODE_EXTRA_CA_CERTS', 'C:\\certs\\corp.pem')).toBe(false)
  })
})

describe('recordPriorEnv', () => {
  it('records a value the user had before setup overwrote it', () => {
    const next = recordPriorEnv(
      { HTTPS_PROXY: 'http://corp-proxy:3128' },
      {},
      ['HTTPS_PROXY'],
    )
    expect(next.HTTPS_PROXY).toBe('http://corp-proxy:3128')
  })

  it('records absence as null, so uninstall knows to delete the variable', () => {
    const next = recordPriorEnv({ NO_PROXY: null }, {}, ['NO_PROXY'])
    expect(next.NO_PROXY).toBeNull()
  })

  it('never records an llm-fw value as the prior one', () => {
    const next = recordPriorEnv({ HTTPS_PROXY: LLMFW_PROXY }, {}, ['HTTPS_PROXY'])
    expect('HTTPS_PROXY' in next).toBe(false)
  })

  it('keeps the first record across a re-run of setup', () => {
    const first = recordPriorEnv({ HTTPS_PROXY: 'http://corp-proxy:3128' }, {}, ['HTTPS_PROXY'])
    const second = recordPriorEnv({ HTTPS_PROXY: LLMFW_PROXY }, first, ['HTTPS_PROXY'])
    expect(second.HTTPS_PROXY).toBe('http://corp-proxy:3128')
  })
})

describe('planEnvRestore', () => {
  it('restores the user value that setup overwrote', () => {
    const plan = planEnvRestore(
      { HTTPS_PROXY: LLMFW_PROXY },
      { HTTPS_PROXY: 'http://corp-proxy:3128' },
    )
    expect(plan.set).toEqual({ HTTPS_PROXY: 'http://corp-proxy:3128' })
    expect(plan.remove).toEqual([])
  })

  it('deletes a variable that did not exist before setup', () => {
    const plan = planEnvRestore({ NO_PROXY: LLMFW_NO_PROXY }, { NO_PROXY: null })
    expect(plan.remove).toEqual(['NO_PROXY'])
    expect(plan.set).toEqual({})
  })

  it('deletes llm-fw values when there is no record at all', () => {
    const plan = planEnvRestore({ NODE_EXTRA_CA_CERTS: LLMFW_CA_WIN }, {})
    expect(plan.remove).toEqual(['NODE_EXTRA_CA_CERTS'])
  })

  it('leaves a value the user changed since setup', () => {
    const plan = planEnvRestore({ HTTPS_PROXY: 'http://edited-by-hand:3128' }, { HTTPS_PROXY: null })
    expect(plan).toEqual({ set: {}, remove: [] })
  })

  it('does nothing for a variable that is not set', () => {
    const plan = planEnvRestore({ HTTPS_PROXY: null }, { HTTPS_PROXY: 'http://corp-proxy:3128' })
    expect(plan).toEqual({ set: {}, remove: [] })
  })

  it('round-trips with recordPriorEnv: install then uninstall returns the user value', () => {
    const before: EnvSnapshot = { HTTPS_PROXY: 'http://corp-proxy:3128', NO_PROXY: null }
    const record = recordPriorEnv(before, {}, ['HTTPS_PROXY', 'NO_PROXY'])
    const installed: EnvSnapshot = { HTTPS_PROXY: LLMFW_PROXY, NO_PROXY: LLMFW_NO_PROXY }
    const plan = planEnvRestore(installed, record)
    expect(plan.set).toEqual({ HTTPS_PROXY: 'http://corp-proxy:3128' })
    expect(plan.remove).toEqual(['NO_PROXY'])
  })
})

describe('parseRegQueryValue', () => {
  const out = [
    '',
    'HKEY_CURRENT_USER\\Environment',
    '    HTTPS_PROXY    REG_SZ    http://127.0.0.1:8080',
    '    NO_PROXY_EXTRA    REG_SZ    x',
    '',
  ].join('\r\n')

  it('returns the value of the named variable', () => {
    expect(parseRegQueryValue(out, 'HTTPS_PROXY')).toBe('http://127.0.0.1:8080')
  })

  it('keeps spaces inside the value', () => {
    const withSpaces = '\r\nHKEY_CURRENT_USER\\Environment\r\n    X    REG_SZ    C:\\Program Files\\a b\r\n'
    expect(parseRegQueryValue(withSpaces, 'X')).toBe('C:\\Program Files\\a b')
  })

  it('does not match a longer variable name that starts with the same text', () => {
    expect(parseRegQueryValue(out, 'NO_PROXY')).toBeNull()
  })

  it('returns null when the variable is absent', () => {
    expect(parseRegQueryValue(out, 'NODE_EXTRA_CA_CERTS')).toBeNull()
  })
})

describe('env-before.json round trip', () => {
  it('reads back what setup wrote, and treats a corrupt file as nothing recorded', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llmfw-env-'))
    try {
      expect(readPriorEnv(dir)).toEqual({})
      writePriorEnv(dir, { HTTPS_PROXY: 'http://corp-proxy:3128', NO_PROXY: null })
      expect(readPriorEnv(dir)).toEqual({ HTTPS_PROXY: 'http://corp-proxy:3128', NO_PROXY: null })
      writeFileSync(join(dir, PRIOR_ENV_FILE), '{not json', 'utf8')
      expect(readPriorEnv(dir)).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
