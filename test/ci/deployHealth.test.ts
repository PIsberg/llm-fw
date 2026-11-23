import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import https from 'node:https'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import type { AddressInfo } from 'node:net'
import { issueUpstreamCert } from '../proxy/lib/tls-trust.js'

// #870: the image's health probe fetched http://127.0.0.1/readyz whatever the
// gateway served, so a gateway with TLS on never reported healthy.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SCRIPT = join(ROOT, 'docker', 'healthcheck.mjs')
const read = (p: string) => fs.readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

function probe(env: Record<string, string>): Promise<number> {
  return new Promise(resolve => {
    const child = execFile(process.execPath, [SCRIPT], { env: { PATH: process.env.PATH ?? '', ...env }, timeout: 15_000 }, () => {})
    child.on('exit', code => resolve(code ?? -1))
  })
}

describe('container health probe (#870)', () => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'llm-fw-health-'))
  let plain: http.Server
  let secure: https.Server
  let status = 200
  const good = issueUpstreamCert('gateway.example.com')
  const other = issueUpstreamCert('gateway.example.com')
  const files = { cert: join(dir, 'tls.crt'), key: join(dir, 'tls.key'), otherCert: join(dir, 'other.crt') }

  beforeAll(async () => {
    fs.writeFileSync(files.cert, good.cert)
    fs.writeFileSync(files.key, good.key)
    fs.writeFileSync(files.otherCert, other.cert)
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => { res.writeHead(req.url === '/readyz' ? status : 404); res.end() }
    plain = http.createServer(handler)
    secure = https.createServer({ key: good.key, cert: good.cert }, handler)
    await new Promise<void>(r => plain.listen(0, '127.0.0.1', () => r()))
    await new Promise<void>(r => secure.listen(0, '127.0.0.1', () => r()))
  })
  afterAll(() => { plain.close(); secure.close(); fs.rmSync(dir, { recursive: true, force: true }) })
  const port = (s: http.Server | https.Server) => String((s.address() as AddressInfo).port)

  it('reports a plain gateway healthy while /readyz is 200, and not on 503', async () => {
    status = 200
    expect(await probe({ LLM_FW_GATEWAY_PORT: port(plain) })).toBe(0)
    status = 503
    expect(await probe({ LLM_FW_GATEWAY_PORT: port(plain) })).toBe(1)
    status = 200
  })

  it('speaks HTTPS to a gateway with TLS on, trusting the certificate it was given', async () => {
    expect(await probe({ LLM_FW_GATEWAY_PORT: port(secure), LLM_FW_GATEWAY_TLS_CERT: files.cert, LLM_FW_GATEWAY_TLS_KEY: files.key })).toBe(0)
  })

  it('does not trust a certificate other than the configured one', async () => {
    expect(await probe({ LLM_FW_GATEWAY_PORT: port(secure), LLM_FW_GATEWAY_TLS_CERT: files.otherCert, LLM_FW_GATEWAY_TLS_KEY: files.key })).toBe(1)
  })

  it('is what the image runs, and the image turns the audit trail on as config.ts says it does', () => {
    const df = read('Dockerfile')
    expect(df).toMatch(/^COPY docker\/healthcheck\.mjs /m)
    expect(df).toMatch(/^\s+CMD node docker\/healthcheck\.mjs\s*$/m)
    expect(df).toMatch(/^ENV LLM_FW_AUDIT_ENABLED=true$/m)
  })
})

describe('Helm chart (#870)', () => {
  const dep = read('deploy/helm/llm-fw/templates/deployment.yaml')
  const values = read('deploy/helm/llm-fw/values.yaml')

  it('switches a listener off in the process, not only in the Service', () => {
    expect(dep).toMatch(/- name: LLM_FW_PROXY_ENABLED\n\s+value: \{\{ \.Values\.proxy\.enabled \| quote \}\}/)
    expect(dep).toMatch(/- name: LLM_FW_DASHBOARD_ENABLED\n\s+value: \{\{ \.Values\.dashboard\.enabled \| quote \}\}/)
  })

  it('passes every listener its port, not only the gateway', () => {
    expect(dep).toMatch(/- name: LLM_FW_PROXY_PORT\n\s+value: \{\{ \.Values\.proxy\.port \| quote \}\}/)
    expect(dep).toMatch(/- name: LLM_FW_DASHBOARD_PORT\n\s+value: \{\{ \.Values\.dashboard\.port \| quote \}\}/)
  })

  it('mounts a TLS secret for the gateway and probes it over HTTPS', () => {
    expect(values).toMatch(/^\s+tls:\n\s+secretName: ""/m)
    expect(dep).toContain('LLM_FW_GATEWAY_TLS_CERT')
    expect(dep).toContain('secretName: {{ .Values.gateway.tls.secretName }}')
    // Every probe follows the scheme.
    const probes = dep.match(/httpGet:\n(?:\s+.*\n){1,4}/g) ?? []
    expect(probes).toHaveLength(3)
    for (const p of probes) expect(p).toMatch(/scheme: \{\{ if \.Values\.gateway\.tls\.secretName \}\}HTTPS\{\{ else \}\}HTTP\{\{ end \}\}/)
  })

  it('refuses more than one replica on one ReadWriteOnce volume', () => {
    expect(dep).toMatch(/if and \(gt \(int \.Values\.replicaCount\) 1\) \.Values\.persistence\.enabled[\s\S]{0,40}fail /)
  })
})
