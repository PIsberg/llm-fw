# Implementation Plan: Data Loss Prevention & Secret Redaction (PLAN-dlp.md)

This plan outlines the step-by-step implementation for extending `llm-fw` to detect and redact sensitive data (secrets, PII) in outbound prompts, as specified in `SPEC-dlp.md`.

---

## 🗺️ Implementation Phases

We will execute the implementation in **4 sequential phases**.

### Phase 1: Configuration & DLP Engine Setup
1.  **Extend Configuration**:
    Modify `src/config/config.ts` to support DLP settings:
    ```json
    {
      "dlp": {
        "enabled": true,
        "mode": "redact", // "block" | "redact" | "audit"
        "detectors": ["aws", "github", "slack", "private_keys", "entropy"]
      }
    }
    ```
2.  **Create Regex Dictionary**:
    Create `src/detection/dlp/patterns.ts` containing high-confidence regex rules for major SaaS providers, cloud platforms, and PII formats.

### Phase 2: Secret Scanning Pipeline
1.  **DLP Scanner Module**:
    Create `src/detection/dlp/scanner.ts`.
    *   Implement an efficient text scanner that parses the JSON payload strings.
    *   Apply the active regex patterns.
    *   Implement the entropy-based generic token detection (scanning words adjacent to credential keywords).
2.  **Redaction Logic**:
    Implement the string replacement utility that safely rewrites the JSON payload while maintaining valid JSON structure.

### Phase 3: Proxy Integration
1.  **Hook into Proxy Pipeline**:
    Modify `src/proxy/proxy.ts` and `src/detection/pipeline.ts`.
    *   Add the DLP scanner as **Stage 0** (before Prompt Injection heuristics).
    *   If `mode === "block"`, terminate the request and return the 403 response.
    *   If `mode === "redact"`, update the proxy's active request buffer with the rewritten JSON payload and forward it.
2.  **Event Logging**:
    Dispatch a new `DLPEvent` to the EventBus whenever a secret is found, specifying the type (e.g., "AWS_ACCESS_KEY").

### Phase 4: Dashboard & Verification
1.  **Dashboard Visuals**:
    Modify `src/dashboard/server.ts` to add a new "Data Loss" badge and display the DLP events in the local UI.
2.  **Testing**:
    *   Unit tests for `scanner.ts` validating all regex patterns and edge cases (JSON escaping).
    *   E2E proxy tests verifying that an outbound request containing a GitHub token is successfully blocked or redacted without breaking the HTTP connection.
