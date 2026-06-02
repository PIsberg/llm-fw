# Specification: Data Loss Prevention & Secret Redaction (SPEC-dlp.md)

This specification describes how `llm-fw` can be extended to inspect inbound prompts for sensitive local data (PII, API keys, credentials) before they are forwarded to upstream LLM APIs, mitigating accidental data exposure.

---

## 1. The Threat Model: Accidental Data Exposure

When developers build LLM applications, they often pass massive chunks of local context (log files, code snippets, environment variables) into the prompt. It is highly common for sensitive data to accidentally leak into these prompts:

*   **API Keys & Tokens**: e.g., AWS access keys, GitHub personal access tokens, OpenAI/Anthropic keys.
*   **Credentials**: Database connection strings, passwords.
*   **PII**: Personally Identifiable Information (SSNs, credit card numbers, internal employee emails).

If this data is sent to a third-party LLM provider, it becomes a severe security incident, violating compliance (GDPR, SOC2) and risking organizational compromise.

---

## 2. Architecture: Pre-flight Secret Scanning

`llm-fw` will intercept the payload of outbound requests targeted at recognized LLM APIs (e.g., Anthropic, Gemini) and run a fast, regex-based secret scanning pipeline before forwarding the traffic.

### Data Flow

```mermaid
sequenceDiagram
    participant Client
    participant FW as llm-fw Proxy
    participant API as Upstream LLM API
    
    Client->>FW: POST /v1/messages (Contains AWS Key)
    Note over FW: 1. Intercept JSON payload
    Note over FW: 2. Scan text nodes for secrets
    alt Strict Blocking Mode
        FW-->>Client: 403 Forbidden (Blocked: Secret Detected)
    else Redaction Mode
        Note over FW: 3. Rewrite AWS Key to [REDACTED_AWS_KEY]
        FW->>API: POST /v1/messages (Redacted payload)
        API-->>FW: 200 OK
        FW-->>Client: 200 OK
    end
```

---

## 3. Detection Strategies

To minimize latency impact, the DLP engine must run in **< 5ms**.

### Strategy 1: High-Confidence Regex Matching
The firewall will include a curated dictionary of high-confidence regular expressions matching standard credential formats.
*   **Cloud Providers**: AWS (`AKIA...`), GCP Service Account keys, Azure connection strings.
*   **SaaS Tokens**: GitHub (`ghp_...`), Slack (`xoxb-...`), Stripe (`sk_live_...`).
*   **Format Signatures**: Private Keys (`-----BEGIN RSA PRIVATE KEY-----`), Database URIs (`mongodb+srv://...`).

### Strategy 2: High-Entropy String Detection
Not all secrets have strict prefixes. Passwords and generic tokens appear as high-entropy randomized strings.
*   Use Shannon Entropy calculations on whitespace-delimited words.
*   If a string of length > 20 has high entropy and is adjacent to keywords like `password=`, `secret:`, or `token=`, flag it as a generic secret.

### Strategy 3: PII Pattern Matching
Standard regex matching for localized PII:
*   Credit Card Numbers (Luhn algorithm validation).
*   Social Security Numbers (SSN).

---

## 4. Enforcement Actions

Administrators can configure how `llm-fw` reacts to a detected secret:

1.  **Block (Strict)**: The connection is aborted immediately, returning a `403 Forbidden` with the specific type of secret that triggered the block.
2.  **Redact (Transparent)**: The firewall dynamically rewrites the JSON payload, replacing the sensitive string with a standard marker (e.g., `[REDACTED_CREDENTIAL]`). The request continues transparently.
3.  **Audit (Monitor)**: The request is forwarded unmodified, but a high-priority event is logged to the local dashboard.
