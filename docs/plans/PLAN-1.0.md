[llm-fw](../../README.md) > [Documentation](../README.md) > Plans > Road to 1.0.0

# Road to 1.0.0 GA

What has to be true before llm-fw ships 1.0.0, in the order the work happens.
Each item is ticked when it is done and verified; the status line under it says
how it was verified, or who it is waiting on.

Phases run in order, except that 1 and 2 overlap: the threat model feeds the
stability decisions. Phase 3 needs the published container image from Phase 2.

Legend: `[x]` done, `[ ]` open, `[~]` prepared and waiting on a maintainer
action (a merge, a publish, a setting, a purchase).

## Phase 0: clear what is already known

- [x] **GHSA-83jp-cppw-c3v6** (Responses API tool output never scanned).
  Status: published 2026-10-24, patched in 0.8.0 (vulnerable `<= 0.7.0`).
  Still to do: rebase the parked draft PR #392 per its HANDOVER (#377).
- [x] **#391** benign tool output refused (2.2% of 1,382 real Codex outputs).
  Status: five wording fixes, ruleset 2026.10.84. Codex replay 17 refusals to
  6; 0 of 23,938 eval verdicts changed; `fpr` unchanged (2.68%, Dolly and
  oasst1 0 of 2,000). The 6 left (a `.bat` echo, a workflow comment, an
  AI-guidelines file, a Go source file, a QUICK_REFERENCE, an `rg` hit) stay
  in #391; plain reads of them are covered by opt-in `trustedPaths`. Not a
  1.0 blocker.
- [~] **#452 and #432** (Semgrep lock pins, lock freshness workflow).
  Status: both pins (`opentelemetry-api` 1.37.0, `mcp` 1.29.0) recorded as
  accepted CI-only risk in `SECURITY.md`; neither ships in the package or the
  image, and Semgrep itself pins them. #452 stays open until a Semgrep release
  relaxes the otel pin. Waiting on: the repository setting "Allow GitHub
  Actions to create and approve pull requests" (#432), currently off
  (`can_approve_pull_request_reviews: false`, checked 2026-10-24), or a
  GitHub App token in the workflow.

## Phase 1: define what 1.0 promises

- [x] `docs/STABILITY.md`: what semver covers. Status: written. Decided
  2026-10-24: dashboard operations routes only (`/metrics`, `/ca.*`, `/crl`,
  `GET /api/status`), the rest of `/api/*` serves the UI.
- [x] State that detection verdicts are governed by `RULESET_VERSION`, not by
  semver. Status: in `docs/STABILITY.md`.
- [x] Naming sweep before the freeze. Status: decided 2026-10-24. Env var names
  that differ from their config key are frozen as-is and listed in
  `docs/STABILITY.md`; `llmfw_scan_duration_ms` renamed to
  `llmfw_scan_duration_seconds`; no deprecated aliases found in `src/`.
- [x] Schema version on the audit log record. Status: `"schema": 1` on every
  record and webhook batch, tested. `config.json` stays unversioned: it is a
  partial overlay merged onto defaults, so a missing key already means "the
  default".
- [x] Mark experimental, outside the promise: token-saving modules, the judge.
  Status: in `docs/STABILITY.md`.
- [ ] 0.8 to 1.0 upgrade notes. The breaking changes so far are listed under
  "Changed before the freeze" in `docs/STABILITY.md`; the upgrade guide is
  written at release time.

## Phase 2: security review

Findings so far:

- Fixed: the audit webhook posted `payload_full` and `payload_preview` with
  `includePayloads` off; the file sink did not. Found while adding the audit
  schema version. Both sinks now build one record.
- Fixed: compressed request bodies were scanned as raw bytes, so a gzip or
  zstd body passed unread. Now decoded first, and refused when undecodable.
- Fixed, opt-in: Codex CLI signed in with ChatGPT talks to
  `chatgpt.com/backend-api/codex`, which llm-fw did not intercept.
  `proxy.inspectChatgptBackend` (off by default, decided 2026-10-24) intercepts
  it and passes the rest of chatgpt.com through. Not yet verified against a live
  Codex session.

- [x] `docs/THREAT-MODEL.md`: assets (CA key, provider keys, prompts, audit
  log, licence), attackers (remote network client, local process, malicious web
  page, malicious upstream response, malicious tool output or MCP server,
  malicious repository in cwd), one trust boundary per listener. Status:
  written 2026-10-24; every mitigation names the code that enforces it.
- [x] Proxy: CONNECT target validation on a standalone bind (internal hosts,
  `169.254.169.254`), header and target parsing, request smuggling,
  Content-Encoding handling and decompression bombs. Status: a remote client
  could tunnel into the host's loopback and link-local addresses
  (GHSA-q53q-qg98-p9jf), fixed in 0.9.0; compressed bodies passed unscanned,
  now decoded and capped at `proxy.maxBodyBytes` (#458).
- [x] Gateway: tenant isolation, SSRF through routing, provider keys in errors,
  logs or the dashboard, quota bypass. Status: reviewed 2026-10-24. Routing
  maps each slug to a fixed or operator-configured host, so a caller picks
  only the path. Order is auth, route, tenant provider allowlist, quota, body,
  screen, then cache or forward; a refused provider costs no quota. The
  response cache keys on tenant, session, every credential header and the
  URL, stores only 200s and answers nothing without a credential. Fixed: three
  error logs printed the query string, where Google and Azure put the key;
  the auth-path exemption from key custody now uses the canonical path.
  Accepted: an upstream error body reaches the client unchanged, so OpenAI's
  "Incorrect API key provided: sk-...abcd" shows the last four characters of
  an operator key.
- [x] Dashboard: the loopback exemption behind a same-host reverse proxy, DNS
  rebinding against `127.0.0.1:7731`, the Origin check, SSE. Status: DNS
  rebinding reached the dashboard and a loopback gateway on a default install
  (GHSA-c725-vwcm-h8rr), fixed in 0.9.0: loopback trust now needs a loopback
  `Host`.
- [x] Detection bypass: parser differentials against the providers (duplicate
  JSON keys, encodings, alternative content shapes), normalization
  differentials, a per-provider sweep for text-bearing fields that are not
  scanned. Status: invalid JSON and repeated keys are refused (stage
  `malformed-body`); Content-Encoding is decoded (#458). Per-provider
  sweep: server and hosted-tool results (Anthropic, OpenAI Responses,
  Gemini), Anthropic `search_result` blocks and Cohere `documents` were not
  read and now are. Normalization: 15 invisible-character variants of one
  injection probed as tool output; the 3 that passed (U+034F, U+3164,
  U+FFF9/U+FFFB) are refused now, pinned by three corpus rows. Request paths
  are matched canonically.
- [x] Config: cosmiconfig searches upward from cwd and evaluates
  `llm-fw.config.js`; can a cloned repository run code or disable detection?
  Hot-reload races. Status: it could (GHSA-4578-7p8f-hc8r), fixed in 0.9.0:
  config is read only from `LLM_FW_DIR`, `LLM_FW_*` variables and a JSON file
  named by `LLM_FW_CONFIG`; cosmiconfig is gone.
- [x] CA and files: key permissions on Windows and Linux, `LLM_FW_DIR`, CRL.
  Status: reviewed 2026-10-24. Windows: icacls drops inheritance and grants
  the user and SYSTEM only (verified on a fresh directory: `ca.key` lists
  exactly those two); the user is now domain-qualified. POSIX: directory 0700,
  `ca.key` now 0600 in its own right. `LLM_FW_DIR` is read from the process
  environment only. The CRL and `ca.crt` are public by design. Accepted: with
  no `USERNAME` in the environment the ACL is left as inherited.
- [x] CLI and service: systemd unit, Task Scheduler entry, `setup` editing the
  environment, uninstall leftovers. Status: reviewed 2026-10-24. The Task
  Scheduler XML is written under the per-user %TEMP% and removed after
  `schtasks /Create`; the systemd unit and launchd plist live in the user's
  home; `setup` writes HKCU via `setx` or appends a marked block to the shell
  profile, which uninstall strips by marker. Fixed: uninstall edited or
  deleted a `.llm-fw.json` in the working directory. Accepted: the systemd
  `ExecStart` quotes each argument but does not escape `%` or `$`, which only
  matters for an install path containing them.
- [x] Licence: offline licence forgery, Paddle fulfilment trust. Status:
  reviewed 2026-10-24. Keys and licence files are Ed25519-verified offline
  against compiled-in keys. The licence gates nothing functional: it feeds
  `doctor`, the status line and the unlicensed banner only. Accepted:
  `LLM_FW_KEYGEN_PUBLIC_KEY` and `LLM_FW_OFFLINE_LICENSE_KEY` override the
  verify keys (documented in `docs/LICENSING.md` for staging), so a user can
  make their own install report itself licensed, which in an open-source
  package is no more than editing the code. Paddle: `Paddle-Signature` is an
  HMAC-SHA256 over `ts:body`, 300 s window, constant-time compare. Accepted:
  `scripts/fulfill-paddle-webhook.ts` is run by hand and does not look up an
  existing licence for the transaction, so running it twice issues a second
  key for the same purchase.
- [x] DoS: ReDoS in heuristics, embedding CPU per byte, body limits, the
  WebSocket relay. Status: quadratic regexes and tokenizer fixed in 0.9.0;
  embedding passes have a per-request budget (64 dense 40 KB messages: 391 s
  to 48 s); a fragmented WebSocket message is now held to
  `proxy.maxBodyBytes` (it grew without limit). Accepted: the heuristic
  stage reads every byte at about 0.25 s per 40 KB message, linear up to
  the 10 MiB body limit, on the request thread; an attacker needs a token
  on any non-loopback bind, and `dos` rate limits apply.
- [x] Fail-open versus fail-closed, written down per path.
  Status: a table of 18 paths under "Failure Semantics" in
  `docs/guides/configuration.md`, each read from the code it names.
- [x] Fuzzers for the provider parsers and the normalizer, in the suite.
  Status: `test/fuzz/parsers.fuzz.test.ts` already held never-throws
  properties for every parser method and normalizer; `body-and-path.fuzz.test.ts`
  adds agreement properties for the repeated-key check and the canonical path
  (300 runs each). Mutating either implementation fails 3 of its 4 properties.
- [x] Triage current CodeQL, Semgrep and Scorecard findings. SBOM attached to
  releases. Status: 2026-10-24, no open CodeQL, Semgrep, Dependabot or
  secret-scanning alerts; 7 Scorecard findings. Vulnerabilities: the npm
  package audits clean (`npm audit --omit=dev`, 0); dev-only zod moved to
  4.6.7; dev-only fast-uri 3.1.8 waits for 3.1.9 to clear the 7-day cooldown
  on 2026-10-26. Pinned-Dependencies, Code-Review and CII-Best-Practices are
  accepted as before. The release workflow now attaches a CycloneDX SBOM.
- [ ] External pentest: decide yes or no.

## Phase 3: remote server testing

- [ ] Container image published to GHCR: provenance, multi-arch (amd64, arm64),
  signed. The Helm chart's `image.repository` points at it.
- [ ] Follow `docs/guides/deployment-server.md` literally on a Linux VM; every
  failing step is a doc bug.
- [ ] Install paths: npm global plus systemd, Docker, Helm on k3s.
- [ ] Modes: `--standalone` with CA distribution to remote clients (Claude Code,
  Codex, curl, Python SDK), `--gateway` with tenants and server-held keys, both
  in one process.
- [ ] Behind nginx or Caddy terminating TLS.
- [ ] Attack from a second host: port scan, unauthenticated CONNECT, open relay,
  metadata endpoint, token brute force.
- [ ] 48 to 72 hour soak with memory and CPU graphs, concurrent clients, log
  rotation, Prometheus scrape, k8s probes, audit log to a SIEM.
- [ ] Failure modes: upstream down, Ollama down, OOM kill, restart keeps the CA,
  in-place upgrade from 0.8.

## Phase 4: quality bar and platforms

- [ ] GA accuracy criteria as numbers, published in `docs/SCORECARD.md`, plus a
  real-traffic replay result. Decide whether #221, #273, #287 and #405 block 1.0.
- [ ] Install matrix: Windows, macOS, Linux on Node 22, 24, 26; setup, uninstall,
  setup again leaves the machine clean.
- [ ] Commercial licence purchase tested end to end.
- [ ] Docs claim audit of the README and guides against the code.
- [ ] `SECURITY.md` supported-versions table moved to 1.x.

## Phase 5: release

- [ ] `1.0.0-rc.1` on the `next` dist-tag, about two weeks of daily use, fixes
  as `rc.N`.
- [ ] 1.0.0 cut with the `release` skill; tag and publish are the maintainer's.

## Not 1.0 work

#360, #366, #416 (token savings) and #371 (simplified installers) ship after
1.0 unless pulled in deliberately.
