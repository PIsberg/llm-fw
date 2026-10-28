[llm-fw](../../README.md) > [Documentation](../README.md) > Plans > Road to 1.0.0

# Road to 1.0.0 GA

What has to be true before llm-fw ships 1.0.0, in the order the work happens.
Each item is ticked when it is done and verified; the status line under it says
how it was verified, or who it is waiting on.

Phases run in order, except that 1 and 2 overlap: the threat model feeds the
stability decisions. Phase 3 needs the published container image from Phase 2.

Legend: `[x]` done, `[ ]` open, `[~]` prepared and waiting on a maintainer
action (a merge, a publish, a setting, a purchase).

## Where it stands (2026-10-26)

No release yet: the maintainer is holding 0.9.2 / `1.0.0-rc.1` until the work
below is merged.

Done on 2026-10-25, merged to main the same day:

- #479: a blocked tool result is withheld instead of refusing the request,
  and "Mark false positive" works on tool results. Per-session replay: 32 of
  245 sessions outside llm-fw ended by a block before, 10 after.
- #481: the docs claim audit (Phase 4) is finished, every `json` block in the
  docs is parsed by a test, and the GA accuracy criteria are proposed
  (Phase 4).

### Open pull requests, in merge order

Each builds on the one above and shares files with it (`CHANGELOG.md`, this
plan, `heuristic.ts`, `ruleset.ts`). Merge them in this order with merge
commits, not squash, so each later one stays conflict-free and keeps its green
CI. All were green on 2026-10-26.

| PR | What | Ruleset |
| --- | --- | --- |
| #491 | Override lexicons for 37 languages; every playground example tested, in every language; Aya benign corpus in `fpr` | 2026.10.87 |
| #494 | `npm run recall:floor`: a per-split floor on direct-injection recall in CI (closes #480) | |
| #496 | 7 persona jailbreaks blocked on purpose; an OpenAI response's `"refusal": null` no longer refused (closes #492) | 2026.10.88 |
| #497 | "Act as X and stay in character" no longer blocked, trading safeguard row 862 (closes #495) | 2026.10.89 |
| #499 | README instructions and "unrestricted free speech" no longer blocked (closes #485, #486); held-out rows read during rule work listed, recall reported on unseen rows | 2026.10.90 |
| #500 | `jailbreak-classification`, the split no rule was tuned on, gated with a floor and a benign ceiling | |
| #501 | A blocked earlier message is withheld instead of ending the session (closes #476) | 2026.10.91 |
| #502 | A taint warning is reported once per session and host (closes #489) | 2026.10.92 |
| #503 | Blocks and would-blocks stay in the dashboard event list (closes #488) | |
| #498 | Two tests that failed under full-suite load (closes #493). Based on main, no shared files: merge any time | |

What they measured, default config, judge and classifier off:

- Direct injection on the four tuned splits: 627 of 853 before the chain,
  633 after (#480's loss explained: 7 rows had been blocked only by an
  accidental obfuscation bonus, 1 by an embedding margin a benign anchor
  closed).
- The never-tuned `jailbreak-classification` split: 311 of 542 jailbreaks
  (57.4%) and 6 of 637 benign prompts (0.9%) blocked. That 57.4% is the
  generalisation number to publish for 1.0, next to the tuned splits' 74%.
- 7-day per-session replay of this machine's Claude Code traffic (407
  sessions): 18 ended at a blocked prompt before #501, none after; all 17
  blocked prompts and 310 blocked tool results are withheld once a newer
  message follows.
- `npm run fpr` unchanged throughout (2.68%; Dolly, oasst1 and Aya samples 0).

Held-out hygiene, decided 2026-10-26: rules were tuned that day by reading 21
safeguard rows and 1 heldout row, so those splits no longer cleanly measure
unseen attacks. The rows are listed in `test/eval/lib/seenRows.ts` and
`recall:floor` prints recall on unseen rows beside the floor. From now on,
write fresh variants instead of opening a held-out row, list any row that was
read, and never open a `jailbreak-classification` row
(`.claude/rules/detection.md`).

### Leftovers

Waiting on a maintainer decision:

- Merge the chain above, then cut the next release: 0.9.2 or `1.0.0-rc.1`
  (Phase 5).
- Sign off the proposed GA accuracy criteria and the recommendation that none
  of #221, #273, #287 and #405 blocks 1.0 (Phase 4). The criteria table now
  includes the never-tuned split and unseen-row recall.
- External pentest: yes or no (Phase 2).
- Make the GHCR package public after the first release (Phase 3).
- The repository setting "Allow GitHub Actions to create and approve pull
  requests" for the lock freshness workflow (#432, Phase 0).
- #478: rendering the architecture diagrams (`docs/images/0*-*.svg`) needs
  `@mermaid-js/mermaid-cli`, which downloads a headless Chromium, and a drift
  check in CI. A dependency and CI-cost decision; the mermaid source in
  `docs/ARCHITECTURE.md` is current, the rendered SVGs are not.
- #475: Realtime WebSocket sessions still refuse a blocked tool output where
  the proxy and gateway withhold it. A documented asymmetry; changing it is a
  behaviour change.

Blocked on something other than a decision:

- #483 (78 playground languages with no rule): measure the judge on the
  multilingual fixture first. Needs a running Ollama.
- #484 (override shapes the lexicons miss): needs a second multilingual
  held-out set written before any rule, generated through the translation
  service.
- #490 (11 lexicon languages with no human-written benign check): needs
  benign prompts in Slovak, Bulgarian, Romanian, Hebrew, Norwegian, Kazakh,
  Azerbaijani, Uzbek, Croatian, Bosnian and Czech; neither Aya nor oasst1 has
  them.
- #459: verify `proxy.inspectChatgptBackend` against a live Codex CLI session
  signed in with ChatGPT.
- #474: one warned event with no stage or match; needs more detail from the
  reporter to act on.
- Infrastructure, not started: the Linux VM walkthrough of
  `deployment-server.md`, the install paths and modes, the attack from a
  second host, the 48 to 72 hour soak and the failure modes (Phase 3), the
  install matrix across Windows, macOS and Linux on Node 22, 24 and 26, and
  the commercial licence purchase end to end (Phase 4). This machine has WSL
  (Ubuntu 22.04) and Docker Desktop, installed but not running; using either
  is the maintainer's call, and nothing has been installed into them.

Can be done without anyone, not started:

- #477: a withheld tool result takes its useful output with it; the model
  only sees the notice. Needs a design for what, if anything, to keep.

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
  (GHSA-q53q-qg98-p9jf), fixed in 0.9.1; compressed bodies passed unscanned,
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
  (GHSA-c725-vwcm-h8rr), fixed in 0.9.1: loopback trust now needs a loopback
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
  Hot-reload races. Status: it could (GHSA-4578-7p8f-hc8r), fixed in 0.9.1:
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
  deleted a `.llm-fw.json` in the working directory; the systemd `ExecStart`
  did not escape `%`, `$`, backslash or `"` in the install path (#465).
- [x] Licence: offline licence forgery, Paddle fulfilment trust. Status:
  reviewed 2026-10-24. Keys and licence files are Ed25519-verified offline
  against compiled-in keys. The licence gates nothing functional: it feeds
  `doctor`, the status line and the unlicensed banner only. Accepted:
  `LLM_FW_KEYGEN_PUBLIC_KEY` and `LLM_FW_OFFLINE_LICENSE_KEY` override the
  verify keys (documented in `docs/LICENSING.md` for staging), so a user can
  make their own install report itself licensed, which in an open-source
  package is no more than editing the code. Paddle: `Paddle-Signature` is an
  HMAC-SHA256 over `ts:body`, 300 s window, constant-time compare. Fixed:
  `scripts/fulfill-paddle-webhook.ts` issued a second key when run twice for
  one transaction; it now returns the existing one (#466).
- [x] DoS: ReDoS in heuristics, embedding CPU per byte, body limits, the
  WebSocket relay. Status: quadratic regexes and tokenizer fixed in 0.9.1;
  embedding passes have a per-request budget (64 dense 40 KB messages: 391 s
  to 48 s); a fragmented WebSocket message is now held to
  `proxy.maxBodyBytes` (it grew without limit). The scan now hands the
  event loop back between steps and every 50 ms, and the Caesar decoder no
  longer builds 25 copies: the longest stall for one 2.5 MB text fell from
  10.6 s to 1.7 s, for 64 messages of 40 KB from 3.9 s to 0.15 s; live
  through the gateway, another client's worst wait during a 2.5 MB request
  fell from 11.1 s (with dropped connections) to 3.1 s. Accepted by the
  maintainer on 2026-10-24 (#464 closed): one heuristic pass over one whole
  text cannot pause, about 0.4 s per MB, so a 10 MiB text still stalls
  other requests for several seconds. An attacker needs a token on any
  non-loopback bind, and `dos` rate limits apply; worker-thread scanning
  and a per-request text cap were considered and not taken.
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

- [~] Container image published to GHCR: provenance, multi-arch (amd64, arm64),
  signed. The Helm chart's `image.repository` points at it. Status: prepared
  2026-10-24 (`.github/workflows/image.yml`, chart 0.2.4): a build-only
  amd64+arm64 job on PRs that touch the image inputs (the maintainer's choice),
  and on a release a push of `ghcr.io/pisberg/llm-fw:<version>` and `:latest`
  with provenance (`mode=max`) and an SBOM. Waiting on: the first release, then
  making the GHCR package public. Not done: signing beyond the provenance
  attestation (cosign).
- [ ] Verify `proxy.inspectChatgptBackend` against a live Codex CLI session
  signed in with ChatGPT (#459).
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
  rotation, Prometheus scrape, k8s probes, audit log to a SIEM. Before it, fix
  what an hour of observe mode on 2026-10-25 showed: the dashboard keeps 100
  events and a would-block was evicted in about 15 minutes, so 4 would-blocks
  could not be traced (#488); 59 of those 100 events were one taint warning on
  every `api.github.com` connection (#489, fixed 2026-10-26: reported once per
  session, host and token). #488 fixed the same day: blocked events stay
  listed beside the ring; still in memory only (the audit log, off by
  default, is the durable record).
- [ ] Failure modes: upstream down, Ollama down, OOM kill, restart keeps the CA,
  in-place upgrade from 0.8.

## Phase 4: quality bar and platforms

- [~] GA accuracy criteria as numbers, published in `docs/SCORECARD.md`, plus a
  real-traffic replay result. Decide whether #221, #273, #287 and #405 block 1.0.
  Replay so far (PR #479, 2026-10-25): 7 days of this machine's Claude Code
  transcripts replayed per session, 407 sessions. Sessions ended by a block:
  outside llm-fw 32 of 245 before, 10 with tool results withheld; inside llm-fw
  and its fixtures 54 of 162 before, 8 after. The rest are prompt-surface
  harness text (#476).
  Status: proposed 2026-10-25, waiting on the maintainer. GA ships when the
  release tree measures at least these, the values of ruleset 2026.10.86
  (default config, judge and classifier off):

  | Criterion | Value now | Gated by |
  | --- | --- | --- |
  | Accuracy gate, `corpus.json` | precision >= 95%, recall >= 80%, each category >= 60% | CI, every PR |
  | Realistic benign agent traffic blocked | 9 of 336 (2.68%) | CI `npm run fpr` |
  | Dolly-15k and oasst1 samples blocked | 0 of 2,000 each | CI `npm run fpr` |
  | Indirect injection (InjecAgent) | 1,054 of 1,054 | nightly drift gate |
  | Direct injection, held-out splits | heldout 23 of 31, safeguard 490 of 650 | nightly drift gate |
  | Direct injection, all four splits | 627 of 853 (73.5%): gandalf 97 of 112, safeguard 490 of 650, deepset 17 of 60, heldout 23 of 31. Ruleset 2026.10.88 (#492): 634 of 853, safeguard 497. Ruleset 2026.10.89 (#495): 633 of 853, safeguard 496 | CI `npm run recall:floor`, per split, one row of margin |
  | Jailbreaks, never-tuned split (jackhhao/jailbreak-classification, added 2026-10-26) | ruleset 2026.10.90: 311 of 542 (57.4%) blocked, 6 of 637 benign (0.9%) blocked. The generalisation number with no fitting at all | CI `npm run recall:floor`, floor and benign ceiling |
  | Direct injection, unseen rows only | ruleset 2026.10.90: 613 of 831 (73.8%): safeguard 477 of 629, heldout 22 of 30, no gandalf or deepset rows listed. 22 rows were read during rule work on 2026-10-26; earlier work is not recorded (`test/eval/lib/seenRows.ts`), so this, not the row above, is the generalisation number | printed by `recall:floor`, not gated |
  | Real sessions ended by a block, outside llm-fw | 10 of 245 (ruleset 2026.10.86). Ruleset 2026.10.91 (#476): 0 of 407 sessions end at a block; 18 see one refusal, on the turn the blocked message was sent | none; the per-session replay, run before the rc |
  | Proposed, ruleset 2026.10.87: playground attacks in 132 languages | 681 of 1,197; held-out phrasings 226 of 798 | CI `multilingual-playground.test.ts` (floors) |
  | Proposed, ruleset 2026.10.87: human-written prompts in 70 languages blocked | 0 of 2,795 (Aya sample) | CI `npm run fpr` |

  Proposed answer on the four issues: none blocks 1.0, because detection
  verdicts move under `RULESET_VERSION`, not semver, so each can keep
  improving after 1.0 without a major version. #221 (direct recall) is the
  73.5% row above, published as a number rather than closed. It was 635 of
  853 on 2026-10-10 (the table in `docs/guides/tuning.md`), so 8 direct
  injections were lost between then and ruleset 2026.10.86 without any gate
  failing (#480); `npm run recall:floor` now catches the next one. #273 (embedding
  false positives) is held by the `fpr` rows: the two of its families fixed
  in #286 stay fixed, and a regression fails CI. #287 (decide by surface)
  shipped its first two pieces: `wordingAction: warn` (opt-in) and
  withholding blocked tool results (#479, default). #405 (rogue-AI game
  code) now withholds the one tool result instead of ending the session, and
  `trustedPaths` (opt-in) covers its file reads.
- [ ] Multilingual coverage: decide what 1.0 claims for languages other than
  English, and close or defer each of these. Measured 2026-10-25 on ruleset
  2026.10.87 (default config).
  - #483: 78 of the 132 playground languages (Aymara, Quechua, Mizo, Zulu,
    ...) have no rule or lexicon, and the embedding stage cannot carry them:
    no threshold separates translated attacks from benign text. First step:
    measure the judge on the multilingual fixture; if it closes them, the
    answer is documentation.
  - #484: attack shapes the lexicons do not cover ("your instructions are
    cancelled", "pay no attention to what you were told", "skip the earlier
    directions"): held-out phrasings block 226 of 798. Needs a second
    held-out set written before any rule, since the first has been seen.
  - #490: 11 lexicon languages (Slovak, Bulgarian, Romanian, Hebrew,
    Norwegian, Kazakh, Azerbaijani, Uzbek, Croatian, Bosnian, Czech) have no
    human-written benign check; neither Aya nor oasst1 has them.
  - #487: Dutch "Schakel veiligheidsfilters uit" passes (separable verb).
  - #485, #486: two English false positives the multilingual benign set
    exposed ("Follow the previous instructions in the README ...",
    "Is unrestricted free speech protected ...?"), pinned as known blocks.
  - The DLP "Bearer token" and "Private key" examples are not checked in
    translation (the translator rewrites the protocol word and the PEM
    armour); their English forms are.
- [ ] Install matrix: Windows, macOS, Linux on Node 22, 24, 26; setup, uninstall,
  setup again leaves the machine clean.
- [ ] Commercial licence purchase tested end to end.
- [x] Docs claim audit of the README and guides against the code. Status:
  started 2026-10-24 on the hardening branch: the README quoted a stale
  13.38% false-positive rate (now 2.68%) and the client-setup uninstall steps
  described removed behaviour; both fixed. Checked mechanically across the
  README and every guide, all clean: each documented llm-fw flag exists in
  `src/cli`, each `LLM_FW_*` variable is read by the code, and each dotted
  config key names a field in `src/types.ts`. Prose read against the code
  on 2026-10-24, all matching: `deployment-server.md` (generated token
  length, the auth header and rejection status per surface, unauthenticated
  `/ca.crt`, `/ca.pem`, `/crl`, health endpoints only on the gateway,
  `/metrics` behind dashboard auth, the image `HEALTHCHECK`) and
  `gateway-mode.md` (routing table, key custody of headers and query
  parameters, tenant tokens beside the deployment token, quota 429 with
  `Retry-After`, the Helm `replicaCount` note); metric names match in both
  directions; `cli.md` lists every dispatched subcommand except `license`,
  now added. Gaps fixed: the Realtime section did not mention the new
  message size cap. The remaining guides read against the code on
  2026-10-25 (PR stacked on #479), claims reproduced where they were
  measurable. The `trustedPaths` JSON example did not parse (every
  `json` block is now parsed by `test/ci/docsJsonExamples.test.ts`); the
  detection-stages worked examples, judge trigger range, default judge model
  and anchor count were stale; the README's streaming scan, "zero added
  latency" and "under 2 seconds" boot were wrong or unmeasured (measured: a
  short prompt scans in 6.7 ms median, a cached start took 2.1 and 2.5 s);
  the MCP guide said a credential in a tool result is blocked where the
  default redacts it; the Anthropic and OpenAI Node SDKs were said to honour
  `HTTPS_PROXY` and do not; `setup` was said to configure Cursor and does
  not; `node tsx.cmd` commands failed with a SyntaxError. Read, not
  re-measured: the measurement sections of `token-savings.md` (its module
  table, order and all 23 option defaults were checked against
  `DEFAULT_CONFIG` and `BUILTINS`).
- [ ] `SECURITY.md` supported-versions table moved to 1.x.

## Phase 5: release

The next release may be numbered 0.9.2 rather than an rc (maintainer's call,
2026-10-25). The checks below apply to whichever release comes next; the rc
steps apply to the release that is the 1.0 candidate.

- [ ] At the first release after the hardening branch: confirm the new `sbom`
  job attached `llm-fw-vX.Y.Z.cdx.json` to the GitHub Release (it cannot run
  before one). Dev-only fast-uri is already 3.1.9 in the lockfile on main
  (checked 2026-10-26).
- [ ] `1.0.0-rc.1` on the `next` dist-tag, about two weeks of daily use, fixes
  as `rc.N`.
- [ ] 1.0.0 cut with the `release` skill; tag and publish are the maintainer's.

## Not 1.0 work

#360, #366, #416 (token savings) and #371 (simplified installers) ship after
1.0 unless pulled in deliberately.
