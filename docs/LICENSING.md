# Licensing llm-fw to a customer

How a commercial licence gets to a paying customer, and — separately — how to hand out a
licence with no Keygen policy or Paddle transaction behind it at all.

Two channels, both verified **fully offline** (no network call, no provider account needed
to check a licence — only the opt-in `llm-fw license --verify` round-trip talks to Keygen):

| Channel | Issued by | Customer sets | Covered by |
|---|---|---|---|
| **Keygen key** (bought via Paddle at deversity.se/llmfw) | Keygen, on payment | `llm-fw license --activate <key>` | [Part 1](#part-1--keygen-keys-bought-through-paddle) |
| **Offline licence file** (issued directly) | you, by hand | `llm-fw license --activate-file <path>` | [Part 2](#part-2--offline-licence-files) |

If both are present on a machine, the offline file wins — see
[`licenseStatus()`](../src/license/status.ts).

---

## Part 1 — Keygen keys (bought through Paddle)

Paddle takes the money; it has no licence engine, so Keygen mints and validates the key.
Fulfilment is a person: Paddle emails you, you issue the key.

1. Customer buys at <https://deversity.se/llmfw>. Paddle's webhook notifies you.
2. Issue an `ED25519_SIGN` key under the Keygen policy for the account in
   `src/license/account.ts` (`keygenAccountId()`).
3. Send it: `llm-fw license --activate <key>`.
4. Log it, same convention as any other sale.

`src/license/keygenKey.ts` verifies the key's signature against
`src/license/account.ts`'s `KEYGEN_PUBLIC_KEY` — no network. `llm-fw license --verify` is the
one opt-in exception, and exists only to catch revocation, which a signature cannot express.

## Part 2 — Offline licence files

For a licence with **no Keygen policy or Paddle transaction behind it**: a custom deal, a
complementary licence, an OSS grant, a beta tester. This is a second, independent signing
key from the Keygen one — rotating or losing it does not touch a single Keygen-issued key,
and vice versa.

A file is one line:

```
LFW1.<base64url(payload)>.<base64url(Ed25519 signature)>
```

The payload is `key=value` lines: `product` (always `llm-fw`), `licensee`, `issued`,
`expires` (ISO date, inclusive) and optionally `plan`. See
[`src/license/offlineLicense.ts`](../src/license/offlineLicense.ts) for the verifier and
[`scripts/issue-offline-license.ts`](../scripts/issue-offline-license.ts) for the issuer.

### One-time setup: generate the signing keypair

```bash
node --import tsx/esm scripts/issue-offline-license.ts keygen ~/.config/deversity/llmfw-offline-license-signing
```

Writes `private.pem` (**operator machine only — never commit it, never send it**) and
`public.pem`, and prints the 64-char hex public key. Paste that into
`OFFLINE_LICENSE_VERIFY_KEY` in `src/license/account.ts` and ship it — that constant is
what lets a customer's machine check a file with no network and no account. The tool
refuses to overwrite an existing `private.pem`: rotating it invalidates every file already
issued against released versions.

> **Published builds ship this constant empty.** As of 0.4.1 the npm package has no
> compiled-in offline verify key, so offline licensing reports `unconfigured` and
> `--activate-file` will not accept a file. Either build from source with the constant
> filled in, or set `LLM_FW_OFFLINE_LICENSE_KEY` to the hex public key at runtime.
> Keygen-issued licence keys are unaffected.

### Issue a file

```bash
node --import tsx/esm scripts/issue-offline-license.ts issue \
  --key ~/.config/deversity/llmfw-offline-license-signing/private.pem \
  --licensee "Acme Corp AB" \
  --expires 2027-08-11 \
  --plan complementary \
  --out acme-corp.lfw-license
```

Verify before sending, exactly as the customer's build will read it:

```bash
node --import tsx/esm scripts/issue-offline-license.ts verify \
  --pub ~/.config/deversity/llmfw-offline-license-signing/public.pem \
  --file acme-corp.lfw-license
```

Log it like any other licence (`offline-file` in the channel column). Renewal is a new file
with a later `--expires`; nothing else changes.

### What to send the customer

> **Your llm-fw licence**
>
> Save the attached `.lfw-license` file somewhere durable and run:
>
> ```
> llm-fw license --activate-file /path/to/acme-corp.lfw-license
> ```
>
> Or, for CI/containers, point `LLM_FW_LICENSE_FILE` at it instead of copying it into
> `~/.llm-fw`. No network access is needed or attempted — the file is signature-verified
> locally. Check it worked with `llm-fw license --status`.
>
> If the file is rejected, `llm-fw doctor` names exactly what's wrong (expired, wrong
> product, tampered in transit). The file expires on the date in our email; renewal is a
> replacement file, and nothing else in your setup changes.

---

## For maintainers: what is actually wired up

| Property | Meaning | Default |
|---|---|---|
| `LLM_FW_LICENSE_KEY` | Keygen key value, for CI/containers that should not write one to disk | unset |
| `<LLM_FW_DIR>/license.key` | What `--activate` writes | — |
| `LLM_FW_OFFLINE_LICENSE_KEY` | Override the compiled-in offline-file verify key; for staging | `OFFLINE_LICENSE_VERIFY_KEY` in `account.ts` |
| `LLM_FW_LICENSE_FILE` | Path to an offline licence file, for CI/containers | unset |
| `<LLM_FW_DIR>/license-offline.lfw` | What `--activate-file` writes | — |

`licenseStatus()` (`src/license/status.ts`) checks the offline file first, then falls back
to the Keygen key. Both map onto the same `LicenseState` (`licensed` / `expired` /
`invalid` / `unverified` / `unlicensed`) so `llm-fw doctor`, `llm-fw start`'s banner and
`llm-fw license --status` do not need to know which channel is in play — `status.source`
(`'env' | 'file' | 'offline-env' | 'offline-file'`) is what names it for a human.

Neither channel can turn off the firewall: `licenseCheck()` in `src/cli/doctor.ts` never
returns `fail` for any licence state, on purpose — see the comment there.
