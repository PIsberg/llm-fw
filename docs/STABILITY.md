[llm-fw](../README.md) > [Documentation](README.md) > Stability

# Stability: what semver covers from 1.0

From 1.0.0, llm-fw follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
for the surfaces listed here. A minor release may add to them; only a major
release may rename, remove or change the meaning of anything on this page.
Everything not listed is internal and may change in any release.

## Covered

| Surface | Where it is defined | What is promised |
| --- | --- | --- |
| CLI | `USAGE` in `src/cli/usage.ts` ([CLI reference](guides/cli.md)) | Subcommands, flags and their aliases keep working. `test/cli/usage.test.ts` fails if a dispatched command or flag is missing from the help text |
| Config keys | the `Config` type in `src/types.ts` ([Configuration](guides/configuration.md)) | Keys, their types and their meaning. New keys are additive and default to the old behaviour |
| `LLM_FW_*` variables | `ENV_OVERRIDES` in `src/config/config.ts`, the generated table in [Configuration](guides/configuration.md) | Names and accepted values. The names that differ from their config key (below) are frozen as they are |
| Library API | `src/index.ts`: `createFirewall` and the `Firewall`, `ScanInput`, `ScanVerdict`, `ScanSource`, `DeepPartial` and `Config` types ([Library](guides/library.md)) | Signatures and verdict shape. Fields may be added to returned objects |
| Gateway endpoint | [Gateway mode](guides/gateway-mode.md) | The provider path prefixes it documents (`/anthropic`, `/openai/v1`, bare `/v1/...` and the rest), the `X-Llm-Fw-Key` and `Authorization: Bearer` credentials, `/healthz`, `/livez`, `/readyz` |
| Refusals | [Configuration: refusal status](guides/configuration.md) | The status code a refused request gets (`422`, or `403` with `blockStatus`) and the shape of its JSON body |
| Dashboard operations routes | `src/dashboard/server.ts` | `/metrics`, `/ca.crt`, `/ca.pem`, `/crl`, `GET /api/status`. Fields may be added to `/api/status` |
| Prometheus metrics | `src/dashboard/metrics.ts` ([Server deployment: monitoring](guides/deployment-server.md#health-checks-and-monitoring)) | Series names, types and label names |
| Audit record | `src/dashboard/auditLog.ts` ([Server deployment: audit log](guides/deployment-server.md#audit-log-and-siem-export)) | The `audit.jsonl` line and the webhook batch. Every record carries `"schema": 1`; adding a field keeps it at 1, renaming or removing one raises it and is a major change |
| Data directory | `<LLM_FW_DIR>`, default `~/.llm-fw` | File names and formats of `ca.crt`, `ca.key`, `ca.crl`, `config.json`, `audit.jsonl`, `suppressions.json`, `whitelist.json` and the licence files. A 1.x release reads what any earlier 1.x wrote |
| Security defaults | [SECURITY.md](../SECURITY.md#security-relevant-defaults) | Loopback binds by default, auth inferred from the bind address, payloads kept out of the audit trail unless opted in. Loosening any of these is a major change |

### Variable names that differ from their config key

Kept as they are, because renaming them would cost every deployment more than
the inconsistency does:

| Variable | Config key |
| --- | --- |
| `LLM_FW_PROXY_BIND` | `proxy.bindHost` |
| `LLM_FW_HTTPS_PORT` | `proxy.httpsPort` (the sinkhole TLS port) |
| `LLM_FW_TOOLUSE_SCAN_*` | `responseScan.toolUse` |
| `LLM_FW_MANYSHOT_*` | `manyShot` |
| `LLM_FW_INDIRECT_TRUSTED_RECIPIENT_DOMAINS` | `indirectInstruction.trustedRecipientDomains` |

## Not covered

- **Detection verdicts.** Whether a given prompt is blocked is governed by
  `RULESET_VERSION`, not by the npm version: a patch release can move a
  threshold and a feature release can leave detection untouched. Every audit
  record names the ruleset that decided it. Detection thresholds and their
  defaults belong to the ruleset too.
- **The rest of the dashboard.** The page itself and every `/api/*` route other
  than `GET /api/status` (events, settings, suppressions, whitelist, test,
  translate, modules, feedback) serve the UI and may change in a minor release.
- **Experimental features.** The gateway's token-saving modules (`modules.*`,
  see [Token savings](guides/token-savings.md)) and the Stage 3 judge
  (`detection.judgeEnabled` and its siblings, Ollama). Their keys keep
  parsing, but their behaviour and options may change in a minor release.
- **Log lines** on stdout and stderr, their wording and their format.
- **Everything under `src/`** that `src/index.ts` does not export.

## Deprecation

A covered name that has to go is deprecated first: it keeps working for the
rest of the major version, logs one warning at startup when used, and is listed
under `### Deprecated` in the CHANGELOG. It is removed only in the next major.

## Changed before the freeze

Breaking changes made in the run-up to 1.0, so they do not have to wait for 2.0:

- `llmfw_scan_duration_ms` is now `llmfw_scan_duration_seconds`, in Prometheus's
  base unit, with buckets from 0.005 to 2.5 seconds. Divide old dashboard
  queries' thresholds by 1000.
- Audit records and webhook batches carry `"schema": 1`.
