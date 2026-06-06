import { describe, it, expect } from 'vitest'
import { stripSinkholeBlock, stripJudgeConfig, stripProfileEnvVars, stripIdeProxyConfig } from '../../src/cli/uninstall.js'

const TARGETS = ['api.anthropic.com', 'generativelanguage.googleapis.com']

describe('stripSinkholeBlock', () => {
  it('removes the marker block setup appended, keeping the rest', () => {
    const hosts = [
      '127.0.0.1 localhost',
      '# my own entry',
      '10.0.0.5 internal.example',
      '# llm-fw sinkhole',
      '127.0.0.1 api.anthropic.com',
      '127.0.0.1 generativelanguage.googleapis.com',
    ].join('\n')

    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toContain('127.0.0.1 localhost')
    expect(out).toContain('10.0.0.5 internal.example')
    expect(out).not.toContain('# llm-fw sinkhole')
    expect(out).not.toContain('api.anthropic.com')
    expect(out).not.toContain('googleapis.com')
  })

  it('drops stray target loopback lines even if the marker is gone', () => {
    const hosts = '127.0.0.1 localhost\n127.0.0.1 api.anthropic.com\n'
    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toBe('127.0.0.1 localhost\n')
  })

  it('stops the block at the first non-loopback line', () => {
    const hosts = [
      '# llm-fw sinkhole',
      '127.0.0.1 api.anthropic.com',
      '8.8.8.8 dns.example', // ends the block; must be kept
    ].join('\n')
    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toContain('8.8.8.8 dns.example')
    expect(out).not.toContain('api.anthropic.com')
  })

  it('leaves a hosts file with no llm-fw edits unchanged in content', () => {
    const hosts = '127.0.0.1 localhost\n::1 localhost\n'
    expect(stripSinkholeBlock(hosts, TARGETS)).toBe(hosts)
  })

  it('removes ::1 target mappings too', () => {
    const hosts = '::1 api.anthropic.com\n127.0.0.1 keep.example\n'
    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toBe('127.0.0.1 keep.example\n')
  })

  it('handles CRLF line endings (Windows hosts files)', () => {
    const hosts = '127.0.0.1 localhost\r\n# llm-fw sinkhole\r\n127.0.0.1 api.anthropic.com\r\n'
    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toContain('127.0.0.1 localhost')
    expect(out).not.toContain('# llm-fw sinkhole')
    expect(out).not.toContain('api.anthropic.com')
  })

  it('preserves user entries that come after the sinkhole block', () => {
    const hosts = [
      '# llm-fw sinkhole',
      '127.0.0.1 api.anthropic.com',
      '',
      '127.0.0.1 my-app.local',
    ].join('\n')
    const out = stripSinkholeBlock(hosts, TARGETS)
    expect(out).toContain('127.0.0.1 my-app.local')
    expect(out).not.toContain('api.anthropic.com')
  })
})

describe('stripJudgeConfig', () => {
  it('deletes the file (returns null) when only judge keys were present', () => {
    const parsed = { detection: { judgeEnabled: true, judgeModel: 'phi3:latest', judgeBlock: false } }
    expect(stripJudgeConfig(parsed)).toBeNull()
  })

  it('preserves user-authored detection keys', () => {
    const parsed = { detection: { judgeEnabled: true, judgeModel: 'phi3', embeddingBlockThreshold: 0.9 } }
    expect(stripJudgeConfig(parsed)).toEqual({ detection: { embeddingBlockThreshold: 0.9 } })
  })

  it('preserves unrelated top-level keys', () => {
    const parsed = { targets: ['api.anthropic.com'], detection: { judgeBlock: true } }
    expect(stripJudgeConfig(parsed)).toEqual({ targets: ['api.anthropic.com'] })
  })

  it('returns the object unchanged when there is no judge config', () => {
    const parsed = { targets: ['api.anthropic.com'] }
    expect(stripJudgeConfig(parsed)).toEqual({ targets: ['api.anthropic.com'] })
  })
})

describe('stripProfileEnvVars', () => {
  it('removes export statements for HTTPS_PROXY and NODE_EXTRA_CA_CERTS pointing to llm-fw', () => {
    const profile = [
      '# my exports',
      'export PATH=$PATH:/some/path',
      'export HTTPS_PROXY=http://127.0.0.1:8080',
      'export NODE_EXTRA_CA_CERTS=/Users/name/.llm-fw/ca.crt',
      'export OTHER_VAR=value',
    ].join('\n')

    const out = stripProfileEnvVars(profile)
    expect(out).toContain('export PATH=$PATH:/some/path')
    expect(out).toContain('export OTHER_VAR=value')
    expect(out).not.toContain('export HTTPS_PROXY=')
    expect(out).not.toContain('export NODE_EXTRA_CA_CERTS=')
  })

  it('preserves other proxy/cert variables not matching llm-fw destinations', () => {
    const profile = [
      'export HTTPS_PROXY=http://my-corporate-proxy:8080',
      'export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt',
    ].join('\n')

    const out = stripProfileEnvVars(profile)
    expect(out).toContain('export HTTPS_PROXY=http://my-corporate-proxy:8080')
    expect(out).toContain('export NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt')
  })

  it('handles CRLF line endings', () => {
    const profile = 'export PATH=/bin\r\nexport HTTPS_PROXY=http://localhost:8080\r\n'
    const out = stripProfileEnvVars(profile)
    expect(out).toContain('export PATH=/bin')
    expect(out).not.toContain('export HTTPS_PROXY=')
  })
})

describe('stripIdeProxyConfig', () => {
  it('removes proxy keys if configured to llm-fw localhost/127.0.0.1 default proxy', () => {
    const config = {
      'python.languageServer': 'Default',
      'http.proxy': 'http://127.0.0.1:8080',
      'http.proxyStrictSSL': false
    }

    const out = stripIdeProxyConfig(config)
    expect(out).toEqual({ 'python.languageServer': 'Default' })
  })

  it('removes proxy keys if configured to localhost or custom port matching localhost patterns', () => {
    const config = {
      'http.proxy': 'http://localhost:8443',
      'http.proxyStrictSSL': false,
      'other.setting': true
    }

    const out = stripIdeProxyConfig(config)
    expect(out).toEqual({ 'other.setting': true })
  })

  it('preserves proxy keys if they point to an external or corporate proxy', () => {
    const config = {
      'http.proxy': 'http://proxy.corp.example.com:8080',
      'http.proxyStrictSSL': true,
      'other.setting': true
    }

    const out = stripIdeProxyConfig(config)
    expect(out).toEqual(config)
  })
})
