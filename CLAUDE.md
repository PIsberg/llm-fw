# CLAUDE.md

llm-fw is a local prompt-injection firewall for LLM traffic: a TypeScript proxy
and gateway that scan requests in-flight and refuse the malicious ones. Node 22+,
ESM, no framework.

Keep this file short. Detail lives in `.claude/rules/`, loaded on demand.

## Always

- **Branch first.** Never commit to `main`. Open the PR; do not merge it.
- **The gate is `npx tsc --noEmit && npm run lint && npm run build && npm run test:run`.**
  That is what CI runs. A green local run of the full set is the real signal.
- **Every behaviour change ships with a test** in the existing suite, in the
  existing style, under `test/`.
- **Grow the corpus, not the thresholds.** If a detection threshold needs to
  move, say so explicitly with measured before and after. Never lower one to
  make a test pass.
- **Update the docs the change makes wrong, in the same change**, plus a
  `## [Unreleased]` entry in `CHANGELOG.md`.
- **Report failures with the output.** A skipped gate is not a passed gate.

## Read before you work

| Working on | Read |
| --- | --- |
| Detectors, thresholds, the corpus | [.claude/rules/detection.md](.claude/rules/detection.md) |
| Tests, gates, what CI actually runs | [.claude/rules/testing.md](.claude/rules/testing.md) |
| A new config key or env var | [.claude/rules/config.md](.claude/rules/config.md) |
| The proxy, gateway, sinkhole or auth | [.claude/rules/proxy-gateway.md](.claude/rules/proxy-gateway.md) |
| Any documentation change | [.claude/rules/docs.md](.claude/rules/docs.md) |
| Cutting a release | the `release` skill in `.claude/skills/release/` |

## Where things are

```
src/detection/   the pipeline: heuristics, embeddings, judge, DLP, MCP, RAG
src/proxy/       forward proxy, MITM, certificate factory
src/gateway/     reverse-proxy endpoint, routing, tenants
src/config/      defaults, env overrides, hot reload
src/dashboard/   HTTP API, SSE, Prometheus metrics, UI
src/cli/         subcommands; start.ts wires every listener
test/            mirrors src/; *.e2e.test.ts run under vitest.e2e.config.ts
docs/            human documentation, indexed by docs/README.md
```

Contributor-facing rules (style, PR process, reporting) are in
[CONTRIBUTING.md](CONTRIBUTING.md). Product documentation is indexed in
[docs/README.md](docs/README.md).
