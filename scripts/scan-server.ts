/**
 * Minimal HTTP scan server — the cross-language bridge for AgentDojo (Python).
 *
 * AgentDojo (github.com/ethz-spylab/agentdojo) is a Python agent-security
 * benchmark; llm-fw is Node/TS. This server exposes the SAME in-process
 * detection pipeline the proxy and dashboard use — via the documented
 * `createFirewall()` library API (src/api.ts) — over a tiny localhost HTTP
 * endpoint the Python defense adapter (integrations/agentdojo/) can POST to:
 *
 *     POST /scan   { "text": "...", "surface": "tool_result" }
 *       → 200      { "action": "pass|warn|block", "stage", "score", "similarity" }
 *     GET  /health → 200 { "status": "ok" }
 *
 * It deliberately does NOT start the proxy/TLS/dashboard — this is the same
 * "library" integration path documented in src/api.ts, wrapped in the smallest
 * possible HTTP shim so a non-Node caller can reach it. Config layering is
 * identical to every other entrypoint (createFirewall → loadConfig), so the
 * firewall behaves exactly as it would in front of real traffic.
 *
 * Bound to 127.0.0.1 by default: it runs the detection pipeline on arbitrary
 * POSTed text and must not be exposed off-box.
 *
 * Usage:
 *   node --import tsx/esm scripts/scan-server.ts [--port 8790] [--host 127.0.0.1]
 *   LLM_FW_SCAN_PORT / LLM_FW_SCAN_HOST env vars are honoured (flags win).
 */
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createFirewall, type Firewall, type ScanSource, type ScanVerdict } from '../src/api.js'

const VALID_SURFACES: ReadonlySet<ScanSource> = new Set<ScanSource>([
  'prompt', 'system', 'tool_result', 'tool_definition', 'document',
])

/** POST /scan body limit. Tool outputs are text; 4 MB is generous and caps memory. */
const BODY_LIMIT = 4 * 1024 * 1024

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

/**
 * Build the HTTP scan server over an already-initialised Firewall. Exported so
 * tests can drive the exact same request handling against a real firewall on an
 * ephemeral port without spawning a subprocess. Does not call listen().
 */
export function createScanServer(fw: Firewall): http.Server {
  return http.createServer((req, res) => {
    const url = req.url ?? '/'
    const path = url.split('?')[0]

    if (req.method === 'GET' && path === '/health') {
      sendJson(res, 200, { status: 'ok' })
      return
    }

    if (req.method !== 'POST' || path !== '/scan') {
      sendJson(res, 404, { error: 'not found — use POST /scan or GET /health' })
      return
    }

    let body = ''
    let tooLarge = false
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return
      body += chunk
      if (body.length > BODY_LIMIT) {
        tooLarge = true
        sendJson(res, 413, { error: 'payload too large' })
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge) return
      void (async () => {
        let parsed: { text?: unknown; surface?: unknown }
        try {
          parsed = JSON.parse(body || '{}') as { text?: unknown; surface?: unknown }
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' })
          return
        }

        if (typeof parsed.text !== 'string') {
          sendJson(res, 400, { error: '`text` (string) is required' })
          return
        }
        const surface = (parsed.surface ?? 'tool_result') as ScanSource
        if (!VALID_SURFACES.has(surface)) {
          sendJson(res, 400, { error: `invalid surface '${String(parsed.surface)}' — one of ${[...VALID_SURFACES].join(', ')}` })
          return
        }

        try {
          const verdict: ScanVerdict = await fw.scan({ text: parsed.text, surface })
          sendJson(res, 200, {
            action: verdict.action,
            stage: verdict.stage,
            score: verdict.score,
            similarity: verdict.similarity,
          })
        } catch (err) {
          process.stderr.write(`[scan-server] scan error: ${(err as Error).message}\n`)
          sendJson(res, 500, { error: 'scan failed' })
        }
      })()
    })
  })
}

async function main(): Promise<void> {
  const host = flag('host') ?? process.env.LLM_FW_SCAN_HOST ?? '127.0.0.1'
  const port = Number(flag('port') ?? process.env.LLM_FW_SCAN_PORT ?? 8790)

  const fw = await createFirewall()
  const server = createScanServer(fw)

  async function shutdown(): Promise<void> {
    server.close()
    await fw.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())

  server.listen(port, host, () => {
    // A single ready line on stderr so a launching process (the Python runner)
    // can wait for readiness without racing; /health is the programmatic probe.
    process.stderr.write(`[scan-server] listening on http://${host}:${port}  (POST /scan, GET /health)\n`)
  })
}

// Only auto-start when run directly (mirrors scripts/run-benchmark.ts) — the
// server factory is imported by test/api/scan-server.test.ts without listening.
const isMain = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch(e => { console.error(e); process.exit(1) })
}
