# Express middleware example

Illustrative only — not shipped or compiled as part of the package. Wires
`createFirewall()` (see the README's ["Use as a library"](../README.md#use-as-a-library)
section) into an Express app so any request body containing a `prompt` field
is scanned before your route handler runs.

```ts
import express from 'express'
import { createFirewall } from 'llm-fw'
import type { Firewall } from 'llm-fw'

const app = express()
app.use(express.json())

// Create once at startup — createFirewall() loads the detection models, so
// reuse the same Firewall instance across requests instead of constructing
// one per request.
let firewall: Firewall
async function getFirewall(): Promise<Firewall> {
  firewall ??= await createFirewall()
  return firewall
}

function llmFwGuard() {
  return async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const text = req.body?.prompt
    if (typeof text !== 'string' || !text) return next()

    const fw = await getFirewall()
    const verdict = await fw.scan({ text })

    if (verdict.action === 'block') {
      return res.status(403).json({ error: 'prompt injection detected', stage: verdict.stage })
    }
    if (verdict.action === 'warn') {
      console.warn(`[llm-fw] warn at stage=${verdict.stage} score=${verdict.score}`)
    }
    next()
  }
}

app.post('/chat', llmFwGuard(), (req, res) => {
  // req.body.prompt has passed the firewall — forward it to your model call.
  res.json({ ok: true })
})

app.listen(3000)

// On shutdown, release the firewall's resources (worker-thread inference
// pool, if enabled):
process.on('SIGTERM', async () => {
  await firewall?.close()
  process.exit(0)
})
```

This example checks a single `prompt` field for brevity. A real gateway
sitting in front of an LLM API should scan every attacker-influenceable field
in the request (system prompt, tool results, tool definitions) — pass
`surface` accordingly (see `ScanInput` in the README), or forward the whole
provider-shaped request body via `fw.scan({ body, path })` so the bundled
parser extracts every surface itself, the same way the proxy does.
