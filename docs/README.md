[llm-fw](../README.md) > Documentation

# llm-fw documentation

Everything written down about llm-fw, grouped by what you are trying to do.
The [README](../README.md) is the pitch and the quick start; this is the rest.

## Run it

| Guide | For |
| --- | --- |
| [Client setup](guides/client-setup.md) | Pointing a machine, IDE, agent or SDK at a firewall. Certificate trust per OS and per runtime, per-tool recipes, uninstall. |
| [Server deployment](guides/deployment-server.md) | Running one firewall for many clients: systemd, Docker, Kubernetes, tokens, hardening, backup, upgrades, troubleshooting. |
| [Gateway mode](guides/gateway-mode.md) | The reverse-proxy endpoint: routing, provider key custody, tenants and quotas. |
| [Configuration reference](guides/configuration.md) | Every config location and key, and what happens when a stage cannot run. |
| [CLI reference](guides/cli.md) | Every command and flag, `doctor`, and the dashboard. |
| [Use as a library](guides/library.md) | `createFirewall()` in your own process. |
| [Development](guides/development.md) | Running from source. |

## Understand the defenses

| Guide | Covers |
| --- | --- |
| [Detection stages](guides/detection-stages.md) | The attack classes recognised, the three stages in order, and a worked block |
| [Data Loss Prevention](guides/dlp.md) | Secrets, keys and PII leaving in a prompt |
| [Cost control and DoS](guides/cost-control.md) | Rate limits, budgets, agent loop detection |
| [RAG context poisoning](guides/rag.md) | Instructions smuggled in through retrieved documents |
| [ASCII smuggling](guides/ascii-smuggling.md) | Invisible Unicode tag characters carrying a payload |
| [Response-side exfiltration](guides/exfiltration.md) | Data leaving through URLs and images in the model's answer |
| [MCP tool firewall](guides/mcp.md) | Tool definitions, invocations, arguments and results |
| [Tuning detection](guides/tuning.md) | Live toggles, false-positive suppression, per-surface sensitivity |

## How it is built, and how well it works

| Document | Covers |
| --- | --- |
| [ARCHITECTURE.md](ARCHITECTURE.md) | System context, components, sequence and class diagrams |
| [DESIGN-mcp-response.md](DESIGN-mcp-response.md) | Design for correct inbound MCP response interception |
| [BENCHMARK.md](BENCHMARK.md) | Held-out generalization methodology and results |
| [BENCHMARK-COMPETITORS.md](BENCHMARK-COMPETITORS.md) | Head-to-head recall and FPR against third-party guardrails |
| [BENCHMARK-IMPROVEMENTS.md](BENCHMARK-IMPROVEMENTS.md) | Before and after accuracy across every tuning round |
| [BENCHMARK-AGENTDOJO.md](BENCHMARK-AGENTDOJO.md) | AgentDojo agentic-benchmark results |
| [SCORECARD.md](SCORECARD.md) | The generated detection scorecard |
| [FALSE-POSITIVES.md](FALSE-POSITIVES.md) | The false-positive corpus and what it measures |
| [ML-INDIRECT-STUDY.md](ML-INDIRECT-STUDY.md) | Multilingual indirect-injection embedding feasibility study |
| [LOADTESTS.md](LOADTESTS.md) | Load-test harness, throughput and latency results |
| [TESTING.md](TESTING.md) | Unit, integration, E2E and mutation testing |

## Specifications and plans

Written before the code, kept as the record of intent. A `SPEC-` states what a
feature must do; the matching `PLAN-` is how it was built.

| Feature | Spec | Plan |
| --- | --- | --- |
| Prompt injection | [SPEC-promptinj.md](specs/SPEC-promptinj.md) | [PLAN-promptinj.md](plans/PLAN-promptinj.md) |
| Outbound HTTP and exfiltration | [SPEC-http.md](specs/SPEC-http.md) | [PLAN-http.md](plans/PLAN-http.md) |
| Data Loss Prevention | [SPEC-dlp.md](specs/SPEC-dlp.md) | [PLAN-dlp.md](plans/PLAN-dlp.md) |
| Cost control and DoS | [SPEC-dos.md](specs/SPEC-dos.md) | [PLAN-dos.md](plans/PLAN-dos.md) |
| RAG context poisoning | [SPEC-rag.md](specs/SPEC-rag.md) | [PLAN-rag.md](plans/PLAN-rag.md) |
| MCP monitoring and firewall | [SPEC-mcp.md](specs/SPEC-mcp.md) | [PLAN-mcp.md](plans/PLAN-mcp.md) |
| Live traffic monitoring | [SPEC-livetraffic.md](specs/SPEC-livetraffic.md) | [PLAN-livetraffic.md](plans/PLAN-livetraffic.md) |
| Load testing | [SPEC-loadtests.md](specs/SPEC-loadtests.md) | [PLAN-loadtests.md](plans/PLAN-loadtests.md) |

Detection tuning rounds, which have no spec of their own:
[PLAN-improvements-batch2.md](plans/PLAN-improvements-batch2.md) ·
[PLAN-improvements-batch3.md](plans/PLAN-improvements-batch3.md) ·
[PLAN-intent-mention-blending.md](plans/PLAN-intent-mention-blending.md) ·
[PLAN-next-improvements.md](plans/PLAN-next-improvements.md) ·
[PLAN-future.md](plans/PLAN-future.md)

## Project and process

| Document | Covers |
| --- | --- |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Reporting bugs and detection misses, code style, testing requirements, PR process |
| [SECURITY.md](../SECURITY.md) | Reporting a vulnerability |
| [CHANGELOG.md](../CHANGELOG.md) | Release history |
| [PUBLISHING.md](PUBLISHING.md) | Publishing to npm (maintainers) |
| [LICENSING.md](LICENSING.md) | How commercial and offline licences are issued (maintainer runbook) |
| [LICENSE.md](../LICENSE.md) | PolyForm Noncommercial 1.0.0 |
| [NOTICE.md](../NOTICE.md) | Third-party notices |

Agent-facing working rules live in [`.claude/rules/`](../.claude/rules/) and are
indexed from [`CLAUDE.md`](../CLAUDE.md).
