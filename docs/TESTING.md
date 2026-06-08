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
