# Architecture: llm-fw

This document describes the internal design of llm-fw. It covers how the components
are structured, how a request flows through the system, and how each detection stage works.

---

## 1. System Context

```mermaid
flowchart TD
    User["Developer / CI"]
    Client["LLM Client\n(Cursor, CLI, Python script, app)"]
    Proxy["llm-fw Proxy\nlocalhost:8080"]
    Dashboard["llm-fw Dashboard\nlocalhost:7731"]
    Anthropic["api.anthropic.com"]
    Google["generativelanguage.googleapis.com"]

    User -->|uses| Client
    Client -->|HTTPS_PROXY or hosts sinkhole| Proxy
    Proxy -->|PASS: forward request| Anthropic
    Proxy -->|PASS: forward request| Google
    Proxy -->|BLOCK: emit event| Dashboard
    User -->|monitors| Dashboard
```

---

## 2. Component Map

```mermaid
flowchart TD
    subgraph CLI ["src/cli/"]
        setup["setup.ts\n(CA + trust store + model download)"]
        uninstall["uninstall.ts\n(reverse setup: trust store + hosts + redirect)"]
        start["start.ts\n(boot sequence + PID file)"]
        stop["stop.ts\n(SIGTERM + hosts restore)"]
        status["status.ts"]
        doctor["doctor.ts\n(diagnostics + fixes)"]
    end

    subgraph Config ["src/config/"]
        cfg["config.ts\n(cosmiconfig + env overrides)"]
    end

    subgraph Proxy ["src/proxy/"]
        proxyServer["proxy.ts\n(CONNECT + TLS termination)"]
        certs["certs.ts\n(CA + per-host SAN certs)"]
        upstream["upstream.ts\n(external DNS resolver + LRU cache)"]
    end

    subgraph Detection ["src/detection/"]
        normalizer["normalize.ts"]
        parsers["parsers.ts\n(Anthropic + Gemini extractors)"]
        heuristic["heuristic.ts\n(weighted phrase scoring)"]
        embedding["embedding.ts\n(ONNX + sliding window)"]
        judge["judge.ts\n(Ollama HTTP client)"]
        pipeline["pipeline.ts\n(orchestrator)"]
    end

    subgraph Dashboard ["src/dashboard/"]
        httpServer["server.ts\n(GET / + SSE + POST /api/test)"]
        eventBus["eventBus.ts\n(ring buffer + SSE fan-out)"]
    end

    setup --> certs
    setup --> cfg
    uninstall --> cfg
    start --> cfg
    start --> proxyServer
    start --> httpServer
    proxyServer --> certs
    proxyServer --> upstream
    proxyServer --> pipeline
    pipeline --> parsers
    pipeline --> normalizer
    pipeline --> heuristic
    pipeline --> embedding
    pipeline --> judge
    proxyServer --> eventBus
    httpServer --> eventBus
    httpServer --> pipeline
```

---

## 3. Class Diagram — Detection Pipeline

```mermaid
classDiagram
    class PayloadParser {
        <<interface>>
        +supports(path: string) boolean
        +extractPrompts(body: string) string[]
    }

    class AnthropicParser {
        +supports(path) boolean
        +extractPrompts(body) string[]
    }

    class GeminiParser {
        +supports(path) boolean
        +extractPrompts(body) string[]
    }

    class Normalizer {
        +normalize(text: string) string
    }

    class HeuristicScorer {
        -rules: WeightedRule[]
        +score(input: string) HeuristicResult
    }

    class EmbeddingChecker {
        -model: FeatureExtractionPipeline
        -templates: Float32Array[]
        +init() Promise~void~
        +check(input: string) Promise~EmbeddingResult~
        -chunk(input: string) string[]
        -cosineSim(a: Float32Array, b: Float32Array) number
    }

    class JudgeClient {
        -ollamaUrl: string
        -model: string
        +classify(input: string) Promise~JudgeResult~
    }

    class Pipeline {
        -parsers: PayloadParser[]
        -normalizer: Normalizer
        -heuristic: HeuristicScorer
        -embedding: EmbeddingChecker
        -judge: JudgeClient
        -config: DetectionConfig
        +run(path: string, body: string) Promise~PipelineResult~
    }

    class PipelineResult {
        +action: block|pass|warn
        +stage: heuristic|embedding|judge|none
        +score: number
        +similarity: number
        +verdict: string
    }

    PayloadParser <|.. AnthropicParser
    PayloadParser <|.. GeminiParser
    Pipeline --> PayloadParser
    Pipeline --> Normalizer
    Pipeline --> HeuristicScorer
    Pipeline --> EmbeddingChecker
    Pipeline --> JudgeClient
    Pipeline --> PipelineResult
```

---

## 4. Class Diagram — Proxy

```mermaid
classDiagram
    class ProxyServer {
        -certFactory: CertFactory
        -resolver: UpstreamResolver
        -pipeline: Pipeline
        -eventBus: EventBus
        -config: ProxyConfig
        +start() Promise~void~
        +stop() Promise~void~
        -handleConnect(req, socket) void
        -forwardRequest(socket, hostname, port) void
    }

    class CertFactory {
        -ca: CA
        -certCache: Map~string, TLSCredentials~
        +generateCA() CA
        +getHostCert(hostname: string) TLSCredentials
    }

    class UpstreamResolver {
        -resolver: dns.Resolver
        -cache: LRUCache~string, string~
        +resolve(hostname: string) Promise~string~
    }

    class EventBus {
        -ring: BlockEvent[]
        -maxSize: number
        -subscribers: SSEResponse[]
        +emit(event: BlockEvent) void
        +subscribe(res: SSEResponse) void
        +getRecent(limit: number) BlockEvent[]
    }

    class BlockEvent {
        +id: string
        +timestamp: string
        +stage: string
        +score: number
        +similarity: number
        +target: string
        +method: string
        +path: string
        +payload_preview: string
        +action: string
    }

    ProxyServer --> CertFactory
    ProxyServer --> UpstreamResolver
    ProxyServer --> Pipeline
    ProxyServer --> EventBus
    EventBus --> BlockEvent
```

---

## 5. Sequence Diagram — Request PASS (Mode A: HTTPS_PROXY)

```mermaid
sequenceDiagram
    participant C as Client
    participant P as Proxy :8080
    participant Det as Detection Pipeline
    participant Up as Upstream API

    C->>P: HTTP CONNECT api.anthropic.com:443
    P-->>C: 200 Connection Established
    C->>P: TLS ClientHello
    P-->>C: TLS ServerHello (per-host cert, SAN=api.anthropic.com)
    Note over C,P: TLS tunnel established

    C->>P: POST /v1/messages (encrypted, buffered)
    P->>Det: parsers.extractPrompts(body)
    Det-->>P: ["user message text"]
    P->>Det: pipeline.run(path, body)
    Det->>Det: normalize(input)
    Det->>Det: heuristic.score() → score=10
    Note over Det: score < 20 → PASS
    Det-->>P: { action: "pass" }

    P->>Up: forward POST (via external DNS IP)
    Up-->>P: 200 + streaming response
    P-->>C: pipe response (zero-copy, no buffering)
```

---

## 6. Sequence Diagram — Request BLOCK (Stage 2)

```mermaid
sequenceDiagram
    participant C as Client
    participant P as Proxy :8080
    participant Det as Detection Pipeline
    participant EB as EventBus
    participant DB as Dashboard :7731

    C->>P: HTTP CONNECT api.anthropic.com:443
    P-->>C: 200 Connection Established
    C->>P: TLS + POST /v1/messages
    P->>Det: pipeline.run(path, body)
    Det->>Det: normalize → heuristic.score() → score=35
    Note over Det: 20 ≤ score < 50 → escalate to Stage 2
    Det->>Det: embedding.check() → similarity=0.91
    Note over Det: similarity ≥ 0.85 → BLOCK
    Det-->>P: { action: "block", stage: "embedding", similarity: 0.91 }

    P-->>C: HTTP 403 { "error": "prompt injection detected" }

    P->>EB: emit(BlockEvent)
    EB->>DB: SSE push to all subscribers
    Note over DB: Dashboard updates live table
```

---

## 7. Sequence Diagram — Stage 3 Judge (Async Default)

```mermaid
sequenceDiagram
    participant P as Proxy
    participant Det as Pipeline
    participant Up as Upstream API
    participant Ollama as Ollama (local)
    participant EB as EventBus

    Note over P,Det: Stages 1+2 both return PASS (score=35, sim=0.72 warn)
    Det-->>P: { action: "warn", stage: "embedding" }

    par Forward request (< 100ms budget)
        P->>Up: forward POST
        Up-->>P: 200 response
        P-->>P: pipe to client
    and Judge async (fire-and-forget)
        P->>Ollama: POST /api/generate { num_predict:1, temperature:0 }
        Ollama-->>P: "MALICIOUS"
        P->>EB: emit(BlockEvent { stage: "judge", action: "warned-post-facto" })
    end
```

---

## 8. Sequence Diagram — Setup Flow

```mermaid
sequenceDiagram
    actor U as User (elevated)
    participant CLI as llm-fw setup
    participant FS as ~/.llm-fw/
    participant OS as OS Trust Store
    participant HF as HuggingFace CDN

    U->>CLI: llm-fw setup
    CLI->>FS: mkdir ~/.llm-fw/ (chmod 0700)
    CLI->>CLI: generateCA() via node-forge
    CLI->>FS: write ca.crt, ca.key
    CLI->>OS: certutil / security / update-ca-certificates
    OS-->>CLI: CA trusted

    alt --sinkhole flag
        CLI->>FS: backup current hosts file
        CLI->>OS: write 127.0.0.1 entries to hosts
    end

    CLI->>HF: download Xenova/paraphrase-multilingual-MiniLM-L12-v2 q8 (~120MB)
    HF-->>CLI: model files
    CLI->>FS: cache to ~/.llm-fw/models/
    CLI-->>U: Setup complete. Run: llm-fw start
```

---

## 9. Pipeline State Machine

```mermaid
stateDiagram-v2
    [*] --> ExtractPrompts

    ExtractPrompts --> NoPrompt : no user content found
    ExtractPrompts --> Normalize : prompts extracted

    NoPrompt --> Pass : pass through untouched

    Normalize --> Stage1

    Stage1 --> Block : score ≥ 50
    Stage1 --> Stage2 : 20 ≤ score < 50
    Stage1 --> Pass : score < 20

    Stage2 --> Block : max_similarity ≥ 0.85
    Stage2 --> Warn : 0.70 ≤ max_similarity < 0.85
    Stage2 --> Pass : max_similarity < 0.70

    Warn --> JudgeAsync : judgeEnabled=true, judgeBlock=false
    Pass --> JudgeAsync : judgeEnabled=true, judgeBlock=false

    JudgeAsync --> [*] : verdict logged post-facto

    Block --> [*] : HTTP 403 + dashboard event
    Pass --> [*] : forward to upstream
    Warn --> [*] : forward + dashboard warning
```

---

## 10. Data Flow — Embedding Sliding Window

```mermaid
flowchart LR
    Input["Long prompt\n(e.g. 900 tokens)"]
    Tokenize["Approximate tokenization\n(split on whitespace/sentence)"]
    Chunk1["Chunk 1\ntokens 0–200"]
    Chunk2["Chunk 2\ntokens 150–350"]
    Chunk3["Chunk 3\ntokens 300–500"]
    ChunkN["..."]

    Embed1["embed(chunk1)\n→ Float32Array"]
    Embed2["embed(chunk2)\n→ Float32Array"]
    Embed3["embed(chunk3)\n→ Float32Array"]

    Sim1["max cosine_sim\nvs 100 templates"]
    Sim2["max cosine_sim\nvs 100 templates"]
    Sim3["max cosine_sim\nvs 100 templates"]

    MaxScore["max(sim1, sim2, sim3, ...)\n→ final score"]

    Input --> Tokenize
    Tokenize --> Chunk1 & Chunk2 & Chunk3 & ChunkN
    Chunk1 --> Embed1 --> Sim1
    Chunk2 --> Embed2 --> Sim2
    Chunk3 --> Embed3 --> Sim3
    Sim1 & Sim2 & Sim3 --> MaxScore
```

---

## 11. File Structure

```
llm-fw/
├── src/
│   ├── cli/
│   │   ├── setup.ts         # CA generation, trust store, hosts, model download
│   │   ├── setup-judge.ts   # Ollama model pull + judge config
│   │   ├── uninstall.ts     # reverse setup: trust store, hosts, redirect, files
│   │   ├── start.ts         # boot sequence, exit hooks, PID file
│   │   ├── stop.ts          # SIGTERM + hosts restore
│   │   ├── doctor.ts        # environment diagnostics + remediation commands
│   │   └── status.ts
│   ├── proxy/
│   │   ├── proxy.ts         # CONNECT handler, dual-mode (8080/443)
│   │   ├── certs.ts         # CA + per-host SAN cert factory
│   │   └── upstream.ts      # external DNS resolver + LRU cache
│   ├── detection/
│   │   ├── normalize.ts     # Unicode NFKC + zero-width strip
│   │   ├── parsers.ts       # Anthropic + Gemini payload extractors
│   │   ├── heuristic.ts     # weighted phrase scorer
│   │   ├── embedding.ts     # ONNX model + sliding-window checker
│   │   ├── judge.ts         # Ollama HTTP client
│   │   └── pipeline.ts      # orchestrator
│   ├── dashboard/
│   │   ├── server.ts        # HTTP server (Events + Playground + /api/test)
│   │   └── eventBus.ts      # ring buffer + SSE fan-out
│   └── config/
│       └── config.ts        # cosmiconfig + env overrides + defaults
├── data/
│   └── attacks.json         # ~100 canonical injection templates
├── test/
│   ├── detection/           # unit + integration tests per module
│   ├── proxy/               # proxy integration tests
│   └── dashboard/           # dashboard API tests
├── docs/
│   └── ARCHITECTURE.md      # this file
├── spec.md
├── PLAN.md
└── README.md
```

---

## 12. Install Settings — What `setup` Changes and Why

`llm-fw setup` is not a passive install: to transparently intercept HTTPS it has
to plant a trust anchor and (in sinkhole mode) redirect traffic at the OS level.
Every one of those changes is enumerated below with the reason it exists and the
exact reversal `uninstall` performs. The table is the contract between the two
commands — anything `setup` writes must appear here with an undo.

### 12.1 Files under `~/.llm-fw/`

| Setting | What it is | Why it's needed | Reversal |
| --- | --- | --- | --- |
| `ca.key` | RSA-2048 private key of the local root CA | The proxy signs a per-host leaf cert on the fly for every intercepted domain; without the CA key it can't terminate TLS, so it can't read request bodies to scan them. | delete file |
| `ca.crt` | Self-signed root CA certificate (CN `llm-fw Local CA`, 10-yr validity) | This is the public half installed into the OS trust store so clients accept the proxy's leaf certs instead of throwing cert errors. | delete file + remove from trust store (§12.2) |
| `ca.crl` | Empty, CA-signed Certificate Revocation List | Windows Schannel reads the CRL Distribution Point on every cert; with no reachable CRL it rejects the leaf as "revocation status unknown". An empty signed CRL satisfies that check. | delete file |
| dir perms `0700` / restricted ACL | `chmod 0700` (POSIX) or `icacls` inheritance-strip (Windows) on `~/.llm-fw` | The dir holds the CA private key. Any local process that could read it could silently MITM **all** the user's HTTPS traffic, so only the owner (and SYSTEM) may read the folder. | dir is deleted entirely |
| `models/` | Cached `Xenova/paraphrase-multilingual-MiniLM-L12-v2` q8 ONNX weights (~120 MB) | Stage 2 embeds prompts locally (multilingual, 50+ languages); caching avoids re-downloading on every start and keeps detection fully offline. | delete dir (`--keep-model` preserves it to avoid a re-download) |
| `config.json` | `{ "proxy": { "mode": "proxy" \| "sinkhole" } }` | Persists which mode setup configured so `start`, `status`, and `doctor` report and behave correctly without re-passing flags or env vars. Loaded by `config.ts` above project config, below env vars. | delete file |
| `llm-fw.pid` | PID of the running proxy (written by `start`) | Lets `stop`/`status`/`doctor`/`uninstall` find and signal the live process. | proxy stopped, then file deleted |

### 12.2 OS trust store (CA installed system-wide)

| Platform | Install command | Why | Reversal |
| --- | --- | --- | --- |
| Windows | `certutil -addstore -f Root <ca.crt>` | Adds the CA to the machine **Root** store so Schannel-based and Node clients trust the proxy's leaf certs. | `certutil -delstore -f Root "llm-fw Local CA"` |
| macOS | `security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain` | Same, via the System keychain. | `security delete-certificate -c "llm-fw Local CA" …` |
| Linux | copy to `/usr/local/share/ca-certificates/` + `update-ca-certificates` | Same, via the system CA bundle. | delete the file + `update-ca-certificates --fresh` |

**Why trust at all:** the proxy presents a cert it generated, not the real
provider's. Without trusting the CA, every client would (correctly) reject it.
This is the single most security-sensitive setting — it's why the CA key is
locked down (§12.1) and why `uninstall` removes the anchor first.

### 12.3 Sinkhole settings (elevated installs only)

Mode A (proxy) needs none of these — it relies on the client honouring
`HTTPS_PROXY`. Mode B (sinkhole) covers tools that *ignore* proxy env vars
(Node.js, native SDKs) by redirecting at the OS level, which requires admin/root.

| Setting | What it is | Why it's needed | Reversal |
| --- | --- | --- | --- |
| hosts file block | `# llm-fw sinkhole` marker + `127.0.0.1 <host>` for every target provider | Forces DNS for provider domains to loopback so their traffic hits the local TLS server instead of the real API — no client config required. | strip the marker block + any target loopback line (`stripSinkholeBlock`) |
| `hosts.llm-fw.bak` | Pre-edit copy of the hosts file | Safety net so the original can be restored if anything goes wrong. | delete after the hosts file is cleaned |
| port redirect | `netsh portproxy 443→httpsPort` (Win) / `pf rdr` (macOS) / `iptables REDIRECT` (Linux) | The sinkhole TLS server runs on an unprivileged port (8443); this forwards loopback `:443` to it so clients reach it on the standard HTTPS port. | delete the rule (`netsh … delete` / `pfctl -F nat` / `iptables -D`) |
| `iphlpsvc` running | Windows IP Helper service set to auto + started | `netsh portproxy` rules only forward while IP Helper is running. | **left in place** — it's a shared Windows service other software relies on; documented, not reverted |

### 12.4 Stage 3 judge settings (`setup-judge`, optional)

| Setting | What it is | Why it's needed | Reversal |
| --- | --- | --- | --- |
| Ollama model pull | e.g. `ollama pull phi3` | Stage 3 runs a local LLM to reason about intent that regex/similarity miss. | **left in place** — the model is shared and reusable; `uninstall` prints `ollama rm <model>` |
| `.llm-fw.json` judge keys | `detection.judgeEnabled / judgeModel / judgeBlock` written to the project config | Persists that the judge is enabled and which model/blocking mode to use. | strip only those keys (`stripJudgeConfig`); delete the file if nothing user-authored remains |

### 12.5 Environment variables (printed, never set)

`setup` **prints** `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` for the user to
export; it never sets them itself, so it doesn't own them. `uninstall`
therefore can't remove them — it reminds the user to `unset` them and delete the
matching lines from their shell profile.

---

## 13. Uninstall Flow

`llm-fw uninstall` reverses §12 in dependency order: stop the proxy, pull the
trust anchor, undo the sinkhole, then delete local files. Every OS-touching step
is best-effort — a step that fails (rule already gone, or not elevated) prints a
warning and the manual command rather than aborting the rest. The pure
transforms (`stripSinkholeBlock`, `stripJudgeConfig`) are unit-tested in
`test/cli/uninstall.test.ts`.

```mermaid
sequenceDiagram
    actor U as User (elevated)
    participant CLI as llm-fw uninstall
    participant Proc as Running proxy
    participant OS as OS Trust Store
    participant Net as hosts + port redirect
    participant FS as ~/.llm-fw/ + .llm-fw.json

    U->>CLI: llm-fw uninstall [--yes] [--keep-model]
    CLI-->>U: summary + confirm prompt (unless --yes)

    CLI->>Proc: SIGTERM via pid file
    Note over CLI,Proc: stop first so nothing is mid-flight

    CLI->>OS: remove "llm-fw Local CA" (certutil/security/update-ca-certificates)
    OS-->>CLI: trust anchor gone

    alt sinkhole was installed
        CLI->>Net: stripSinkholeBlock(hosts) + delete .llm-fw.bak
        CLI->>Net: delete :443 → httpsPort redirect
    end

    CLI->>FS: stripJudgeConfig(.llm-fw.json)
    CLI->>FS: delete ca.key/ca.crt/ca.crl/config.json/pid (+ models unless --keep-model)
    CLI->>FS: rmdir ~/.llm-fw if empty

    CLI-->>U: reminder: unset HTTPS_PROXY / NODE_EXTRA_CA_CERTS;
    CLI-->>U: iphlpsvc + ollama models left in place
```
