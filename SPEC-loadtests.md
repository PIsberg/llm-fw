# Specification: Load Testing and Accuracy Validation (SPEC-loadtests.md)

This specification outlines the strategy for load testing the `llm-fw` proxy to ensure it remains performant and accurate under stress.

---

## 1. Goals and Requirements

As an intercepting proxy, `llm-fw` sits directly in the critical path of all AI requests. Therefore, we have two paramount requirements:

1.  **Zero Impact on Legitimate Traffic (Performance)**: The proxy must handle high volumes of concurrent traffic without introducing significant latency or becoming a bottleneck. It must not crash or drop legitimate connections under load.
2.  **Low False Positives (Accuracy)**: The security heuristics and LLM judge must accurately distinguish between malicious and benign traffic. Crucially, even under heavy load or complex prompt structures, the False Positive Rate (FPR) must remain extremely low. Legitimate users should not be blocked.

---

## 2. Testing Architecture

To reliably test performance without introducing network variance from external providers (like OpenAI), we will use a localized testing architecture.

```mermaid
graph TD
    A[Load Generator (e.g., k6)] -->|Mixed Traffic| B(llm-fw Proxy)
    B -->|Passed Traffic| C[Mock Upstream Server]
    B -->|Blocked Traffic| D[proxy.log / Dashboard]
    
    subgraph Datasets
    E[Benign Prompts Corpus]
    F[Malicious Prompts Corpus]
    end
    
    E -.-> A
    F -.-> A
```

---

## 3. Core Metrics to Capture

1.  **Latency Overhead**: The difference in p95 and p99 response times when routing through `llm-fw` versus routing directly to the upstream server.
2.  **Throughput**: Maximum Requests Per Second (RPS) the proxy can sustain before latency spikes or connections are refused.
3.  **False Positive Rate (FPR)**: The percentage of requests from the *Benign Dataset* that were incorrectly blocked by the firewall (Goal: near 0%).
4.  **True Positive Rate (TPR) / Recall**: The percentage of requests from the *Malicious Dataset* that were correctly blocked.

---

## 4. Test Scenarios

### Scenario A: Pure Performance (Benign Stress)
*   **Input**: 100% Benign Dataset.
*   **Load Profile**: Ramp up to 500 concurrent virtual users over 60 seconds, sustain for 5 minutes.
*   **Success Criteria**: Zero blocked requests (0 FPR), Latency overhead < 50ms per request, zero dropped connections.

### Scenario B: Accuracy Under Load (Mixed Traffic)
*   **Input**: 90% Benign Dataset, 10% Malicious Dataset.
*   **Load Profile**: Sustained moderate load (e.g., 50 concurrent users) to simulate a busy active environment.
*   **Success Criteria**: FPR remains < 1%, TPR remains > 95%. This proves that concurrency does not cause the detection engine to fail open or fail closed.
