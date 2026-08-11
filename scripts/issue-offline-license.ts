/**
 * Operator tool for llm-fw offline licence files: a licence issued directly,
 * with no Keygen policy or Paddle transaction behind it (custom deals,
 * complementary licences, OSS grants). Not part of the published package.
 *
 * An offline licence file is one line:
 *
 *   LFW1.<base64url(payload)>.<base64url(Ed25519 signature over the payload bytes)>
 *
 * The payload is UTF-8 `key=value` lines with the fields `product`,
 * `licensee`, `issued`, `expires` (ISO date) and optionally `plan`. The
 * library verifies the signature against the public key embedded in
 * src/license/account.ts (`OFFLINE_LICENSE_VERIFY_KEY`) and enforces product
 * and expiry. See src/license/offlineLicense.ts.
 *
 * Modes:
 *   node --import tsx/esm scripts/issue-offline-license.ts keygen <dir>
 *     Generate the Ed25519 signing keypair into <dir>/private.pem and
 *     <dir>/public.pem, and print the hex public key to paste into
 *     src/license/account.ts's OFFLINE_LICENSE_VERIFY_KEY. Refuses to
 *     overwrite an existing private.pem — rotating it invalidates every file
 *     already issued against released versions. Run once; the private key
 *     must never leave the operator machine.
 *
 *   node --import tsx/esm scripts/issue-offline-license.ts issue \
 *     --key <private.pem> --licensee "Acme Corp AB" --expires 2027-08-11 \
 *     [--plan tier] --out acme.lfw-license
 *     Sign and write a licence file.
 *
 *   node --import tsx/esm scripts/issue-offline-license.ts verify \
 *     --pub <public.pem> --file <file>
 *     Re-run the library's checks against a file before sending it.
 */
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign as cryptoSign, verify as cryptoVerify } from 'node:crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const PREFIX = 'LFW1'
const PRODUCT = 'llm-fw'

function parseOpts(args: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 1; i < args.length; i += 2) {
    const flag = args[i]
    if (!flag?.startsWith('--') || i + 1 >= args.length) fail(`expected --option value pairs, got: ${flag}`)
    out[flag!.slice(2)] = args[i + 1]!
  }
  return out
}

function require(opts: Record<string, string>, key: string): string {
  const v = opts[key]
  if (!v || !v.trim()) fail(`missing required option --${key}`)
  return v!
}

function fail(msg: string): never {
  console.error(msg)
  process.exit(1)
}

function keygen(args: string[]): void {
  const dir = args[1]
  if (!dir) fail('usage: keygen <dir>')
  mkdirSync(dir!, { recursive: true })
  const privPath = join(dir!, 'private.pem')
  const pubPath = join(dir!, 'public.pem')
  if (existsSync(privPath)) {
    fail(
      `REFUSING: ${privPath} already exists. Issued licences verify against the key embedded in ` +
        `released versions; replacing the private key breaks every file already issued. Delete it ` +
        `yourself if you really mean to rotate.`,
    )
  }
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(privPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }))
  console.log(`Wrote ${privPath} (keep this on the operator machine only)`)
  console.log(`Wrote ${pubPath}`)
  console.log()
  // SPKI DER is a fixed 12-byte header for Ed25519, then the 32 raw key bytes —
  // strip it to get what OFFLINE_LICENSE_VERIFY_KEY / isOfflineLicenseConfigured
  // actually expect (see src/license/account.ts, src/license/keygenKey.ts).
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const rawHex = spki.subarray(12).toString('hex')
  console.log('Public key (hex, 64 chars) to paste into OFFLINE_LICENSE_VERIFY_KEY in src/license/account.ts:')
  console.log(rawHex)
}

function field(fields: string[], key: string, value: string): void {
  fields.push(`${key}=${value.replace(/\\/g, '\\\\')}`)
}

function issue(opts: Record<string, string>): void {
  const keyPath = require(opts, 'key')
  const licensee = require(opts, 'licensee')
  const expires = require(opts, 'expires')
  const out = require(opts, 'out')
  const plan = opts['plan']

  const exp = new Date(`${expires}T00:00:00.000Z`)
  if (Number.isNaN(exp.getTime())) fail(`--expires ${expires} is not an ISO date (yyyy-mm-dd)`)
  if (exp.getTime() <= Date.now()) fail(`--expires ${expires} is not in the future`)

  const fields: string[] = []
  field(fields, 'product', PRODUCT)
  field(fields, 'licensee', licensee)
  field(fields, 'issued', new Date().toISOString().slice(0, 10))
  field(fields, 'expires', expires)
  if (plan) field(fields, 'plan', plan)
  const payloadBytes = Buffer.from(fields.join('\n'), 'utf8')

  const privateKey = createPrivateKey(readFileSync(keyPath, 'utf8'))
  const signature = cryptoSign(null, payloadBytes, privateKey)

  const file =
    `${PREFIX}.${payloadBytes.toString('base64url')}.${signature.toString('base64url')}`
  writeFileSync(out, file + '\n', 'utf8')

  console.log(`Issued ${out}`)
  console.log(`  licensee: ${licensee}`)
  console.log(`  expires:  ${expires}`)
  console.log()
  console.log('Verify before sending:')
  console.log(`  node --import tsx/esm scripts/issue-offline-license.ts verify --pub <public.pem> --file ${out}`)
}

function verify(opts: Record<string, string>): void {
  const pubPath = require(opts, 'pub')
  const filePath = require(opts, 'file')

  const content = readFileSync(filePath, 'utf8').trim()
  const parts = content.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX) fail(`malformed: expected ${PREFIX}.<payload>.<signature>`)

  const payloadBytes = Buffer.from(parts[1]!, 'base64url')
  const signature = Buffer.from(parts[2]!, 'base64url')
  const publicKey = createPublicKey(readFileSync(pubPath, 'utf8'))
  if (!cryptoVerify(null, payloadBytes, publicKey, signature)) fail('SIGNATURE INVALID')

  const fields: Record<string, string> = {}
  for (const line of payloadBytes.toString('utf8').split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1)
  }

  console.log('Signature: VALID')
  for (const k of ['product', 'licensee', 'issued', 'expires', 'plan']) {
    if (fields[k]) console.log(`  ${k}: ${fields[k]}`)
  }
  if (fields['product'] !== PRODUCT) fail(`wrong product: ${fields['product']}`)
  const exp = new Date(`${fields['expires']}T23:59:59.999Z`)
  if (Number.isNaN(exp.getTime())) fail(`expires is not a valid date: ${fields['expires']}`)
  if (Date.now() > exp.getTime()) fail(`EXPIRED on ${fields['expires']}`)
  console.log(`VALID until ${fields['expires']}`)
}

function usage(): void {
  console.error('usage: node --import tsx/esm scripts/issue-offline-license.ts keygen <dir>')
  console.error(
    '       node --import tsx/esm scripts/issue-offline-license.ts issue --key <private.pem>' +
      ' --licensee <name> --expires <yyyy-mm-dd> [--plan <tier>] --out <file>',
  )
  console.error(
    '       node --import tsx/esm scripts/issue-offline-license.ts verify --pub <public.pem> --file <file>',
  )
}

const args = process.argv.slice(2)
switch (args[0]) {
  case 'keygen':
    keygen(args)
    break
  case 'issue':
    issue(parseOpts(args))
    break
  case 'verify':
    verify(parseOpts(args))
    break
  default:
    usage()
    process.exit(2)
}
