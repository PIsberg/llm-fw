# Testing Guide

`llm-fw` is backed by a robust, multi-layered test suite to ensure the firewall's detection accuracy, proxy stability, and dashboard audit logging operate perfectly under all conditions.

---

## 🎯 Detection accuracy regression gate

`test/detection/accuracy.eval.test.ts` runs the real cheap pipeline (heuristic + embedding, judge off) over a **labeled adversarial corpus** (`test/detection/fixtures/corpus.json`) and asserts:

- **precision ≥ 95%** — benign prompts (incl. hard negatives that mention "ignore"/"system"/"override" legitimately) are almost never blocked;
- **recall ≥ 80%** — overall fraction of attacks blocked;
- **per-category recall ≥ 60%** — every attack family (override, persona, system-extraction, delimiter, fake-mode, social-engineering, encoding, multilingual, RAG) stays covered.

Unlike the load test (which *samples* under concurrency through the proxy), this gate is **deterministic and exhaustive** — every corpus entry runs every time — and it executes as part of `npm run test:run`, so CI fails on any detection change that silently regresses coverage. **Grow the corpus, not the thresholds**, when adding a detector or fixing a miss; lower a threshold only with a deliberate, documented reason.

---

## 🚀 Quick Start: Running Tests

To run the entire test suite locally:

```bash
# Run all tests once
npm run test:run

# Run tests in interactive watch mode (great for development)
npm run test

# Run tests with code coverage reports
npm run test:coverage
```

---

## 🏗️ Testing Architecture

Our test suite is divided into three logical layers, all orchestrated via [Vitest](https://vitest.dev/):

```
┌────────────────────────────────────────────────────────┐
│                      TEST SUITE                        │
├───────────────┬──────────────────────┬─────────────────┤
│ 1. Unit Tests │ 2. Integration Tests │ 3. E2E Tests    │
│  (Heuristics, │    (Dashboard API,   │  (Full Proxy,   │
│  Decoders, NFD)│    Pipeline Flow)   │  Tunnels, TLS)  │
└───────────────┴──────────────────────┴─────────────────┘
```

### 1. Unit & Parser Tests (`test/detection/`)
These verify individual functions and localized components for speed and functional correctness.
*   **[normalize.test.ts](file:///c:/dev/private/llm-fw/test/detection/normalize.test.ts)**: Verifies the normalizer's Unicode decomposition (`NFD`), homoglyph translations, base64/hex/binary/Morse/ROT13/Caesar/Pig Latin decoders, leetspeak translations, and reversed-text reconstructions.
*   **[parsers.test.ts](file:///c:/dev/private/llm-fw/test/detection/parsers.test.ts)**: Tests standard HTTP request/response parsing, focusing on header extraction and prompt body detection.
*   **[heuristic.test.ts](file:///c:/dev/private/llm-fw/test/detection/heuristic.test.ts)**: Validates regex scoring rules, typo-tolerance regular expressions, social engineering indicators, and multi-lingual prompt blocks.

### 2. Integration Tests
These verify how multiple components communicate and pass data within the firewall engine.
*   **[pipeline.test.ts](file:///c:/dev/private/llm-fw/test/detection/pipeline.test.ts)**: Evaluates the integration of parser, candidate extractor, heuristic scoring, and embedding modules.
*   **[evasion.test.ts](file:///c:/dev/private/llm-fw/test/detection/evasion.test.ts)**: A rigorous evaluation utilizing 38 real-world prompt evasion payloads (including base64 overlays, multi-lingual translations, homoglyphs, and sandboxed overrides) to confirm they are blocked.
*   **[dashboard.integration.test.ts](file:///c:/dev/private/llm-fw/test/dashboard/dashboard.integration.test.ts)**: Boots up a mock server to test event storage, retrieval, statistics generation, and REST endpoints.

---

## 🌐 End-to-End (E2E) Proxy Tests

The E2E test suite resides in **[proxy.e2e.test.ts](file:///c:/dev/private/llm-fw/test/proxy/proxy.e2e.test.ts)**. It evaluates a complete network-level round-trip under a fully sandboxed, zero-dependency local simulation.

### How E2E Isolation Works
To guarantee E2E tests run reliably on both local developer machines and offline CI runners (like GitHub Actions) without modifying host certificate stores or requiring internet access:

1.  **Dynamic Sandbox Directory**:
    At the start of the E2E suite (`beforeAll`), the tests generate a unique temporary operating system directory and set it as the active workspace sandbox via `process.env.LLM_FW_DIR`.
2.  **In-Memory Root CA Generation**:
    The suite instantiates a test-isolated Root CA inside the temp directory using `node-forge`. The proxy's certificate factory automatically loads this local CA to intercept and sign hostnames.
3.  **Mock Upstream HTTPS Server**:
    A secure local HTTPS server is started on a random port to act as the target LLM API (`api.anthropic.com`). It records incoming payloads and serves mock API JSON responses.
4.  **Network Tunnel Simulation**:
    A raw TCP client connects to the active `ProxyServer` port, issues an HTTP `CONNECT` command, upgrades the socket to TLS (passing `rejectUnauthorized: false` to trust the dynamic CA cert), and transmits requests.
5.  **Teardown**:
    Upon suite completion (`afterAll`), all servers are shut down, and the sandbox directory is recursively deleted.

### Test Scenarios Covered
*   **Case 1 (Benign Pass-through)**: Sends a safe prompt (`"Hello, write a short poem about coding."`). Confirms the proxy establishes the tunnel, forwards the request intact to the mock upstream, and delivers the response to the client.
*   **Case 2 (Malicious Block)**: Sends a known injection (`"Ignore all previous instructions."`). Confirms the proxy terminates the request locally with `403 Forbidden`, prevents it from reaching the upstream server, and returns a JSON payload detailing the block stage.
*   **Case 3 (Dashboard Log Verification)**: Queries the dashboard server's event endpoint (`GET http://localhost:17731/api/events`) to verify that the blocked injection is fully audited, stored, and queryable.

---

## 🛠️ CI/CD Workflow Integration

Every pull request and merge to `main`, `feat/**`, `fix/**`, and `chore/**` automatically triggers our GitHub Actions pipeline defined in **[.github/workflows/ci.yml](file:///c:/dev/private/llm-fw/.github/workflows/ci.yml)**.

*   **Offline Guarantee**: Our E2E tests do not access the public internet, meaning they run safely and deterministically inside GitHub runners.
*   **Node.js Matrix**: Tests are verified across active LTS Node.js releases (**Node 22** and **Node 24**).
*   **Code Coverage**: Coverage is measured automatically on Node 22 via Vitest and V8 coverage reporters, publishing the artifact for build review.

---

## 🧬 Mutation testing (Task C9)

Line/branch coverage proves code *ran*, not that a test would actually notice
a bug in it. [Stryker Mutator](https://stryker-mutator.io/) makes small,
automated edits ("mutants") to the source — flipping a comparison operator,
truncating a regex, swapping a string-table entry — and reruns the suite; a
mutant that still passes ("survived") marks a spot where the tests wouldn't
catch a real regression there.

Mutation testing is scoped to the seven **regex-boundary detection
modules** — the ones most likely to have quietly-wrong boundary conditions
that ordinary example-based tests don't probe:
`src/detection/{heuristic,normalize,intentMention,indirectInstruction,
harmfulRequest,manyShot,crescendo}.ts`.

Configuration lives in [`stryker.config.json`](../stryker.config.json)
(mutate scope, `@stryker-mutator/vitest-runner`, concurrency 4, 30s mutant
timeout) plus a dedicated
[`vitest.mutation.config.ts`](../vitest.mutation.config.ts) that runs
`test/detection/**` only, further excluding `stage3-judge.test.ts` (live
Ollama) and the handful of suites that exercise the *real* (unmocked)
embedding/classifier model or spin up real worker threads
(`accuracy.eval.test.ts`, `multilingual.test.ts`,
`multilingual-indirect.test.ts`, `image-attacks.test.ts`, `media.test.ts`,
`inferenceIsolation.test.ts`) — Stryker reruns the suite once per surviving
mutant candidate, so anything slow or network-dependent there gets
multiplied across thousands of runs. None of those excluded suites add
mutation coverage on the seven mutated files beyond what the fast/mocked
suites already provide.

**Deliberately not wired into PR CI** — a full run takes several minutes even
scoped down this far, too slow for a per-PR gate. Run it manually with
`npm run mutation`; an opt-in weekly workflow
(`.github/workflows/mutation-weekly.yml`, schedule + `workflow_dispatch`,
`continue-on-error`, never blocks anything) uploads the HTML/JSON report as
a build artifact for periodic review. `.stryker-tmp/` and `reports/mutation/`
are local run artifacts and are gitignored.

### Baseline (recorded 2026-07-06, Stryker 9.6.1, Node 22, concurrency 4)

4,808 mutants generated across the 7 files; 1,621 scored (the rest filtered
by Stryker as static/equivalent before testing). Full run: **4m 27s**.

| File                     | Mutation score | Killed | Timeout | Survived | No coverage |
|--------------------------|---------------:|-------:|--------:|---------:|------------:|
| **All files (baseline)** |     **50.28%** |    803 |      12 |      741 |          65 |
| manyShot.ts              |         91.55% |     65 |       0 |        6 |           0 |
| crescendo.ts             |         79.72% |    113 |       1 |       29 |           0 |
| heuristic.ts             |         73.68% |     42 |       0 |       15 |           0 |
| intentMention.ts         |         67.95% |     53 |       0 |       24 |           1 |
| normalize.ts             |         52.62% |    397 |       5 |      336 |          26 |
| indirectInstruction.ts   |         27.64% |     30 |       4 |       55 |          34 |
| harmfulRequest.ts        |         27.27% |    103 |       2 |      276 |           4 |

`normalize.ts` and `harmfulRequest.ts` — by far the largest files — pull the
overall score down; `manyShot.ts` and `crescendo.ts` (both added with
explicit boundary-condition tests in earlier batches) score well.

### Top 5 surviving-mutant clusters (candidate test gaps — recording only, not fixed here)

1. **`harmfulRequest.ts` — the big keyword/phrase alternation regexes** (227
   survived `Regex` mutants; lines ~186–273: `ABSOLUTE_BLOCK_RE`,
   `INTRUSION_RE`, `isMetaFiction`, `VIOLENCE_RE`, `CHEATING_RE`,
   `PROTECTED_RE`, `OFFENSIVE_RE`). The largest single cluster in the run.
   Tests exercise one or two example phrases per category but never assert
   against alternate words dropped from/added to these `\b(...)/gi`
   alternations, so most character-class, quantifier, or anchor edits inside
   them go unnoticed.
2. **`normalize.ts` — static translation tables** (109 survived
   `StringLiteral` mutants; lines 5–7 Cyrillic/Greek homoglyph maps, 25–26
   leetspeak digit/symbol map, 197 keyword list, 213–214 consonant-cluster
   list used by the pig-latin/reversed-text reconstructor). Only a few
   entries per table are ever exercised by a fixture, so mutating an
   untested entry survives.
3. **`normalize.ts` — decoder boundary conditions** (65 survived
   `ConditionalExpression` mutants; lines 96/103 base85 tuple-length guards,
   136 hex-decode printable-run length check, 278 single-token-ratio
   heuristic, 401/412/421 the `length >= 4` guards gating
   leetspeak/ROT13/pig-latin re-normalization). No fixture lands exactly on
   these thresholds, so off-by-one edits survive.
4. **`indirectInstruction.ts` — the ML exfil-proximity helper block**
   (lines ~500–595: `mlIndices`/`EMAIL_RE`/`ML_SEND_SET`/`ML_MARKER_SET`
   proximity scoring). 34 mutants here have **zero test coverage at all**
   (`NoCoverage`, worse than merely surviving) plus another chunk of the
   file's 55 survived mutants nearby — no test in the fast suite reaches
   this code path.
5. **`harmfulRequest.ts` — snippet/anchor extraction helpers** (38 survived
   `MethodExpression`/`ConditionalExpression` mutants around `snippetAround`
   and the match-group indexing near `VIOLENCE_NOUN_RE` etc., lines
   ~213–256). Tests check the resulting block/warn verdict but rarely
   assert the extracted anchor/snippet text itself, so mutations to the
   extraction logic don't change the verdict being asserted on.

Fixing these gaps is out of scope for this task — grow `test/detection/*`
fixtures deliberately (per-table/per-alternation coverage, boundary-value
cases) as follow-up work, using this list as the prioritized starting point.
