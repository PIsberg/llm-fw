# Implementation Plan: Cost Control & Agentic DoS Protection (PLAN-dos.md)

This plan outlines the implementation roadmap for the Quota Manager and Loop Detector components to prevent agentic loops and billing exhaustion, as specified in `SPEC-dos.md`.

---

## 🗺️ Implementation Phases

We will execute this in **3 sequential phases**.

### Phase 1: Configuration & Quota Manager
1.  **Extend Configuration**:
    Modify `src/config/config.ts` to include limits:
    ```json
    {
      "dos": {
        "enabled": true,
        "maxRequestsPerMinute": 60,
        "maxTokensPerSession": 500000,
        "loopDetectionEnabled": true
      }
    }
    ```
2.  **Quota State Machine**:
    Create `src/detection/dos/quota.ts`.
    *   Implement an in-memory sliding window rate limiter for RPM.
    *   Implement a simple token estimator (using character count $/ 4$ as a fast heuristic, or importing a lightweight tokenizer) to track TPM and Session Budgets.

### Phase 2: Behavioral Loop Detector
1.  **Loop Tracking Module**:
    Create `src/detection/dos/loopDetector.ts`.
    *   Implement an LRU cache or ring buffer of the last 20 request hashes and timestamp tuples.
    *   Implement an exact-match sequence counter (e.g., if Hash $A$ appears 4 times in 10 seconds).
    *   (Optional enhancement): Implement a basic Jaccard similarity check for fuzzy loop detection.

### Phase 3: Proxy Integration & Dashboard
1.  **Hook into Proxy Pipeline**:
    Modify `src/proxy/proxy.ts`.
    *   Before parsing the JSON payload, check the Quota Manager (RPM). If exceeded, instantly return `429 Too Many Requests`.
    *   After parsing the JSON payload, feed the prompt text to the Loop Detector. If an infinite loop is detected, return `429` with a custom error message: `Agent Loop Detected`.
2.  **Update Session Tracking**:
    On receiving a `200 OK` from the upstream API, update the Quota Manager with the actual token counts returned in the API's `usage` response header/body (if available) to correct the estimates.
3.  **Dashboard Visuals**:
    Modify `src/dashboard/server.ts`.
    *   Add a "Metrics" or "Quotas" widget showing current RPM and Token usage against the limits.
    *   Log `DoSEvent` blocks in the event feed.
4.  **Testing**:
    *   Write unit tests for the sliding window rate limiter.
    *   Write an E2E test simulating a run-away script (firing 10 identical requests in 1 second) and assert that request 4+ are blocked with a `429`.
