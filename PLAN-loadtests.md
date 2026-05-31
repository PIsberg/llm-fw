# Implementation Plan: Load Testing (PLAN-loadtests.md)

This plan outlines the steps to build the load testing infrastructure specified in `SPEC-loadtests.md` to guarantee performance and minimize false positives.

---

## 🗺️ Implementation Phases

We will execute this in **4 sequential phases**.

### Phase 1: Test Infrastructure & Datasets
1.  **Tooling Setup**:
    *   Install a load testing framework (e.g., `k6` or `artillery`) as a development dependency.
    *   Create a `test/load/` directory for test scripts and data.
2.  **Mock Upstream API**:
    *   Create `test/load/mockServer.ts`, a simple Express server that accepts `/v1/chat/completions` and immediately returns a dummy HTTP 200 response. This eliminates external network latency from our benchmarks.
3.  **Dataset Curation**:
    *   Create `test/load/data/benign.json`: A large array of standard, safe user prompts (e.g., code generation, summarization, casual chat).
    *   Create `test/load/data/malicious.json`: An array of known jailbreaks, prompt injections, and context poisoning examples.

### Phase 2: Performance Load Script
1.  **Script Creation**:
    *   Create `test/load/performance.js` (k6 script).
    *   Configure it to read randomly from `benign.json` and send requests through the `llm-fw` proxy to the mock upstream.
2.  **Assertions & Thresholds**:
    *   Add assertions to the script to ensure 100% of responses are `200 OK`. Any `403 Forbidden` indicates a False Positive.
    *   Set strict latency thresholds (e.g., `p(95) < 100ms`).

### Phase 3: Accuracy & Mixed Traffic Script
1.  **Mixed Script Creation**:
    *   Create `test/load/accuracy.js`.
    *   Configure the script to inject a ratio (e.g., 9:1) of benign to malicious traffic.
2.  **Custom Metrics Tracking**:
    *   The script will track expected versus actual HTTP status codes.
    *   *Benign expected:* `200 OK`. If `403`, increment False Positive counter.
    *   *Malicious expected:* `403 Forbidden`. If `200`, increment False Negative counter.
3.  **Validation**:
    *   The test passes only if the FPR (False Positive Rate) is below the acceptable threshold (e.g., 1%).

### Phase 4: Automation
1.  **Package.json Scripts**:
    *   Add `npm run test:load:perf` and `npm run test:load:accuracy` to easily execute the suites locally.
2.  **CI/CD Integration**:
    *   Update `.github/workflows/main.yml` (or equivalent CI pipeline) to run the performance and accuracy tests on every PR to ensure new heuristic rules don't degrade performance or spike the false positive rate.
