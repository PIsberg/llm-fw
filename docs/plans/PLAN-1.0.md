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

- [~] **GHSA-83jp-cppw-c3v6** (Responses API tool output never scanned).
  Status: the fix (6841cd4) is on `main` and in the v0.8.0 tag, which is the
  published npm `latest`. The advisory is still a draft, with its patched
  version set to `0.8.0` (vulnerable `<= 0.7.0`). Waiting on: publish it. Then rebase the parked draft PR #392
  per its HANDOVER (#377).
- [x] **#391** benign tool output refused (2.2% of 1,382 real Codex outputs).
  Status: five wording fixes, ruleset 2026.10.84. Codex replay 17 refusals to
  6; 0 of 23,938 eval verdicts changed; `fpr` unchanged (2.68%, Dolly and
  oasst1 0 of 2,000). The 6 left (a `.bat` echo, a workflow comment, an
  AI-guidelines file, a Go source file, a QUICK_REFERENCE, an `rg` hit) stay
  in #391; plain reads of them are covered by opt-in `trustedPaths`. Not a
  1.0 blocker.
- [ ] **#452 and #432** (Semgrep lock pins, lock freshness workflow). Close, or
  record as accepted risk in `SECURITY.md`.

## Phase 1: define what 1.0 promises

- [ ] `docs/STABILITY.md`: what semver covers. Proposed: CLI subcommands and
  flags, config keys and `LLM_FW_*` variables, the library exports in
  `src/index.ts`, dashboard HTTP API routes, the audit log and SIEM record
  format, Prometheus metric names, the `LLM_FW_DIR` layout.
- [ ] State that detection verdicts are governed by `RULESET_VERSION`, not by
  semver.
- [ ] Naming sweep before the freeze: config keys, env vars, metric names,
  deprecated aliases. Every rename after 1.0 is a breaking change.
- [ ] Schema version on the audit log record and on `config.json`.
- [ ] Mark experimental, outside the promise: token-saving modules, the judge.
- [ ] 0.8 to 1.0 upgrade notes.

## Phase 2: security review

- [ ] `docs/THREAT-MODEL.md`: assets (CA key, provider keys, prompts, audit
  log, licence), attackers (remote network client, local process, malicious web
  page, malicious upstream response, malicious tool output or MCP server,
  malicious repository in cwd), one trust boundary per listener.
- [ ] Proxy: CONNECT target validation on a standalone bind (internal hosts,
  `169.254.169.254`), header and target parsing, request smuggling,
  Content-Encoding handling and decompression bombs.
- [ ] Gateway: tenant isolation, SSRF through routing, provider keys in errors,
  logs or the dashboard, quota bypass.
- [ ] Dashboard: the loopback exemption behind a same-host reverse proxy, DNS
  rebinding against `127.0.0.1:7731`, the Origin check, SSE.
- [ ] Detection bypass: parser differentials against the providers (duplicate
  JSON keys, encodings, alternative content shapes), normalization
  differentials, a per-provider sweep for text-bearing fields that are not
  scanned.
- [ ] Config: cosmiconfig searches upward from cwd and evaluates
  `llm-fw.config.js`; can a cloned repository run code or disable detection?
  Hot-reload races.
- [ ] CA and files: key permissions on Windows and Linux, `LLM_FW_DIR`, CRL.
- [ ] CLI and service: systemd unit, Task Scheduler entry, `setup` editing the
  environment, uninstall leftovers.
- [ ] Licence: offline licence forgery, Paddle fulfilment trust.
- [ ] DoS: ReDoS in heuristics, embedding CPU per byte, body limits, the
  WebSocket relay.
- [ ] Fail-open versus fail-closed, written down per path.
- [ ] Fuzzers for the provider parsers and the normalizer, in the suite.
- [ ] Triage current CodeQL, Semgrep and Scorecard findings. SBOM attached to
  releases.
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
