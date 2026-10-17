// Stands in for `lean-ctx proxy start --port=N` in test/modules/leanCtx.test.ts:
// answers /health and POST /v1/compress the way lean-ctx 3.11 does, and logs
// what it was started with and what it was sent to FAKE_LEAN_CTX_LOG, one
// JSON object per line.
//
// Compression: a message of more than four lines keeps its first two and
// gets lean-ctx's omission line plus the retrieve instruction lean-ctx
// appends to a lossy result. Text containing SLOW is answered after 1.5 s
// the first time it is seen; text containing CRASH is written to stderr and
// the process exits. A taken port makes it exit, as lean-ctx does.
import { createServer } from 'node:http'
import { appendFileSync } from 'node:fs'

const port = Number(process.argv.find(a => a.startsWith('--port='))?.slice(7))
const log = (entry) => appendFileSync(process.env.FAKE_LEAN_CTX_LOG, JSON.stringify(entry) + '\n')
log({ started: process.argv.slice(2), env: process.env, cwd: process.cwd() })

const seen = new Set()
const compress = async (text) => {
  if (text.includes('SLOW') && !seen.has(text)) {
    seen.add(text)
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  const lines = text.split('\n')
  if (lines.length <= 4) return text
  return `${lines.slice(0, 2).join('\n')}\n[${lines.length - 2} lines omitted]\n` +
    '[lean-ctx CCR: full original elided to save tokens — call the retrieve tool with hash=0123456789abcdef01234567, or read /state/tee/proxy_0123456789abcdef.log locally]'
}

createServer((req, res) => {
  if (req.url === '/health') return void res.end('ok')
  if (req.method !== 'POST' || req.url !== '/v1/compress') return void res.writeHead(404).end()
  if (req.headers.authorization !== `Bearer ${process.env.LEAN_CTX_PROXY_TOKEN}`) return void res.writeHead(401).end()
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', async () => {
    const { messages } = JSON.parse(body)
    for (const m of messages) {
      log({ compress: m.content, name: m.name })
      if (m.content.includes('CRASH')) {
        process.stderr.write(`panicked while compressing: ${m.content}\n`)
        process.exit(3)
      }
      m.content = await compress(m.content)
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ messages, stats: {} }))
  })
}).listen(port, '127.0.0.1')
