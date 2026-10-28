import { describe, it, expect } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

interface PackageManifest {
  scripts?: Record<string, string>
  devDependencies?: Record<string, string>
}

const PKG = JSON.parse(read('package.json')) as PackageManifest

describe('static analysis suite (#522)', () => {
  it('wires ESLint + SonarJS, Oxlint, and Biome into npm run lint with warnings denied', () => {
    expect(PKG.devDependencies).toHaveProperty('eslint')
    expect(PKG.devDependencies).toHaveProperty('eslint-plugin-sonarjs')
    expect(PKG.devDependencies).toHaveProperty('oxlint')
    expect(PKG.devDependencies).toHaveProperty('@biomejs/biome')
    expect(PKG.devDependencies).toHaveProperty('knip')

    expect(PKG.scripts?.['lint:eslint']).toContain('eslint')
    expect(PKG.scripts?.['lint:oxlint']).toContain('oxlint')
    expect(PKG.scripts?.['lint:oxlint']).toContain('--deny-warnings')
    expect(PKG.scripts?.['lint:biome']).toContain('biome lint')
    expect(PKG.scripts?.['lint:biome']).toContain('--error-on-warnings')

    const lint = PKG.scripts?.lint ?? ''
    expect(lint).toContain('lint:eslint')
    expect(lint).toContain('lint:oxlint')
    expect(lint).toContain('lint:biome')
  })

  it('loads eslint-plugin-sonarjs in eslint.config.js', () => {
    const cfg = read('eslint.config.js')
    expect(cfg).toContain('eslint-plugin-sonarjs')
    expect(cfg).toContain('sonarjs.configs.recommended.rules')
  })

  it('keeps Biome scoped to linting with formatting disabled', () => {
    const biome = JSON.parse(read('biome.json')) as {
      formatter?: { enabled?: boolean }
      assist?: { enabled?: boolean }
      linter?: { enabled?: boolean }
    }
    expect(biome.linter?.enabled).toBe(true)
    expect(biome.formatter?.enabled).toBe(false)
    expect(biome.assist?.enabled).toBe(false)
  })

  it('enables denyWarnings in .oxlintrc.json', () => {
    const oxlint = JSON.parse(read('.oxlintrc.json')) as {
      options?: { denyWarnings?: boolean }
    }
    expect(oxlint.options?.denyWarnings).toBe(true)
  })

  it('auto-wires .githooks/pre-commit via prepare and keeps it safe outside a git checkout', () => {
    expect(existsSync(join(ROOT, '.githooks/pre-commit'))).toBe(true)
    const rawHook = readFileSync(join(ROOT, '.githooks/pre-commit'), 'utf8')
    expect(rawHook).not.toContain('\r\n')
    expect(rawHook).toContain('npx tsc --noEmit')
    expect(rawHook).toContain('npm run lint')
    expect(rawHook).toContain('npm run knip')
    expect(rawHook).toContain('npm run audit')

    // prepare must no-op cleanly when .git is absent (e.g. Docker build or tarball install).
    const prepare = PKG.scripts?.prepare ?? ''
    expect(prepare).toContain('core.hooksPath')
    const inlineIdx = prepare.indexOf('-e ')
    expect(inlineIdx).toBeGreaterThan(-1)
    const scriptBody = JSON.parse(prepare.slice(inlineIdx + 3)) as string
    const isolated = mkdtempSync(join(tmpdir(), 'llm-fw-prepare-'))
    try {
      expect(() => execFileSync(process.execPath, ['-e', scriptBody], { cwd: isolated })).not.toThrow()
    } finally {
      rmSync(isolated, { recursive: true, force: true })
    }
  })

  it('strips scripts.prepare from the published manifest', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llm-fw-strip-prepare-'))
    try {
      const file = join(dir, 'package.json')
      writeFileSync(file, JSON.stringify(PKG))
      execFileSync(process.execPath, [join(ROOT, 'scripts/strip-dev-manifest.mjs'), file])
      const out = JSON.parse(readFileSync(file, 'utf8')) as PackageManifest
      expect(out.scripts?.prepare).toBeUndefined()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs CI, Semgrep, and CodeQL automatically on pushes and pull requests', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('npx tsc --noEmit')
    expect(ci).toContain('npm run lint')
    expect(ci).toContain('npm run knip')

    const semgrep = read('.github/workflows/semgrep.yml')
    expect(semgrep).toMatch(/on:\n {2}push:\n {4}branches-ignore:/)
    expect(semgrep).toContain('pull_request:')
    expect(semgrep).toContain('semgrep scan')

    const codeql = read('.github/workflows/codeql.yml')
    expect(codeql).toContain('github/codeql-action/analyze')
    expect(codeql).toContain('pull_request:')
  })
})

describe('static security & analysis suite (#523)', () => {
  it('wires npm audit into package.json, pre-commit hook, pre-commit config, and CI', () => {
    expect(PKG.scripts?.audit).toBeDefined()
    expect(PKG.scripts?.audit).toContain('npm audit')

    const rawHook = readFileSync(join(ROOT, '.githooks/pre-commit'), 'utf8')
    expect(rawHook).toContain('npm run audit')

    const preCommitConfig = read('.pre-commit-config.yaml')
    expect(preCommitConfig).toContain('id: audit')
    expect(preCommitConfig).toContain('entry: npm run audit')

    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('npm run audit')
  })

  it('configures Socket supply-chain security workflow', () => {
    expect(existsSync(join(ROOT, '.github/workflows/socket.yml'))).toBe(true)
    const socketWf = read('.github/workflows/socket.yml')
    expect(socketWf).toContain('step-security/harden-runner')
    expect(socketWf).toContain('@socketsecurity/cli')
    expect(socketWf).toContain('pull_request:')
  })

  it('configures Snyk vulnerability & logic flaws workflow', () => {
    expect(existsSync(join(ROOT, '.github/workflows/snyk.yml'))).toBe(true)
    const snykWf = read('.github/workflows/snyk.yml')
    expect(snykWf).toContain('step-security/harden-runner')
    expect(snykWf).toContain('snyk')
    expect(snykWf).toContain('pull_request:')
  })

  it('configures NodeJSScan (njsscan) static taint analysis with dedicated config', () => {
    expect(existsSync(join(ROOT, '.github/workflows/njsscan.yml'))).toBe(true)
    const njsscanWf = read('.github/workflows/njsscan.yml')
    expect(njsscanWf).toContain('step-security/harden-runner')
    expect(njsscanWf).toContain('njsscan')
    expect(njsscanWf).toContain('github/codeql-action/upload-sarif')

    expect(existsSync(join(ROOT, '.njsscan'))).toBe(true)
    const njsscanCfg = read('.njsscan')
    expect(njsscanCfg).toContain('node_modules')
    expect(njsscanCfg).toContain('dist')
    expect(njsscanCfg).toContain('reports')
    expect(njsscanCfg).toContain('test')
  })

  it('configures Clinic.js diagnostic profiling without vulnerable devDependencies', () => {
    expect(PKG.scripts?.['perf:clinic']).toBeDefined()
    expect(PKG.scripts?.['perf:clinic']).toContain('clinic doctor')

    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain('npm run perf:clinic')
    expect(ci).toContain('clinic-doctor-data')

    const gitignore = read('.gitignore')
    expect(gitignore).toContain('.clinic/')
  })

  it('keeps Knip configured and clean', () => {
    expect(PKG.devDependencies).toHaveProperty('knip')
    expect(PKG.scripts?.knip).toBe('knip')

    const knipJson = JSON.parse(read('knip.json')) as { ignoreBinaries?: string[] }
    expect(knipJson.ignoreBinaries).toContain('socket')
    expect(knipJson.ignoreBinaries).toContain('snyk')
    expect(knipJson.ignoreBinaries).toContain('njsscan')
  })
})
