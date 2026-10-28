/**
 * Operator fulfilment tool for Keygen licences bought through Paddle.
 *
 * Modes:
 *   1. Direct CLI issuance from a Paddle transaction:
 *      node --import tsx/esm scripts/fulfill-paddle-webhook.ts issue \
 *        --policy <policy-uuid> --token <keygen-api-token> \
 *        --txn <txn_id> --email <buyer@acme.io> [--holder "Acme Corp"] [--plan "Team Annual"]
 *
 *   2. Webhook payload fulfilment (verifies Paddle-Signature + issues key):
 *      node --import tsx/esm scripts/fulfill-paddle-webhook.ts webhook \
 *        --payload <path-to-body.json> --signature <Paddle-Signature> \
 *        --secret <paddle-webhook-secret> --policy <policy-uuid> --token <keygen-api-token>
 */
import { readFileSync } from 'node:fs'
import { issueKeygenLicense, fulfillPaddleWebhook } from '../src/license/paddleFulfillment.js'

function parseOpts(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]
    if (!flag?.startsWith('--') || i + 1 >= args.length) {
      console.error(`expected --option value pairs, got: ${flag ?? ''}`)
      process.exit(2)
    }
    out[flag.slice(2)] = args[i + 1]!
  }
  return out
}

function req(opts: Record<string, string>, key: string, envFallback?: string): string {
  const v = opts[key] ?? (envFallback ? process.env[envFallback] : undefined)
  if (!v || !v.trim()) {
    const fallbackNote = envFallback ? ` (or ${envFallback})` : ''
    console.error(`missing required option --${key}${fallbackNote}`)
    process.exit(2)
  }
  return v.trim()
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const mode = args[0]
  if (mode === 'issue') {
    const opts = parseOpts(args)
    const issued = await issueKeygenLicense({
      policyId: req(opts, 'policy', 'KEYGEN_POLICY_ID'),
      apiToken: req(opts, 'token', 'KEYGEN_API_TOKEN'),
      transactionId: req(opts, 'txn'),
      customerEmail: opts['email'],
      holderName: opts['holder'] ?? opts['email'],
      plan: opts['plan'],
    })
    console.log(`${issued.reused ? 'Already issued for this transaction:' : 'Issued'} Keygen license ${issued.licenseId}`)
    console.log(`  activate: ${issued.activationCommand}`)
    return
  }

  if (mode === 'webhook') {
    const opts = parseOpts(args)
    const rawBody = readFileSync(req(opts, 'payload'), 'utf8')
    const res = await fulfillPaddleWebhook({
      rawBody,
      signatureHeader: req(opts, 'signature'),
      webhookSecret: req(opts, 'secret', 'PADDLE_WEBHOOK_SECRET'),
      keygenPolicyId: req(opts, 'policy', 'KEYGEN_POLICY_ID'),
      keygenApiToken: req(opts, 'token', 'KEYGEN_API_TOKEN'),
    })
    if (res.status !== 'issued') {
      console.error(`Webhook ${res.status}: ${res.reason}`)
      process.exit(res.status === 'ignored' ? 0 : 1)
    }
    console.log(`Issued Keygen license ${res.licenseId} for ${res.transactionId}`)
    console.log(`  activate: ${res.activationCommand}`)
    return
  }

  console.error('usage: node --import tsx/esm scripts/fulfill-paddle-webhook.ts issue --policy <id> --token <tok> --txn <id> [--email <addr>] [--holder <name>]')
  console.error('       node --import tsx/esm scripts/fulfill-paddle-webhook.ts webhook --payload <file> --signature <sig> --secret <sec> --policy <id> --token <tok>')
  process.exit(2)
}

void main()
