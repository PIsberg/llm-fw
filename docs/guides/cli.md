[llm-fw](../../README.md) > [Documentation](../README.md) > CLI reference

# CLI reference

Every command and flag, the built-in diagnostics, and the dashboard.

## CLI reference

| Command | Description |
|---------|-------------|
| `llm-fw setup` | Generate CA cert (an existing valid one is kept), install to trust store, download model, set `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` (user env / shell profile), auto-configure the proxy in detected VS Code / Antigravity IDE settings, and enable the sinkhole when run with admin/root (covers both proxy and Node.js/native tools) |
| `llm-fw setup --proxy-only` | Skip the sinkhole; configure proxy mode only (no admin needed) |
| `llm-fw setup-judge` | Install Ollama model and enable Stage 3 judge |
| `llm-fw start` | Start proxy and dashboard. One instance runs at a time: a second `start` replaces the running one (including one `install-service` launched) and prints the PID it replaced |
| `llm-fw stop` | Ask the running process to shut down gracefully (restores the hosts file and removes the port redirect if sinkhole mode, flushes the audit log), on Windows too; signals it after 5 s if it does not answer |
| `llm-fw status` | Show running state, enforcement (`observe` means nothing is blocked), proxy, sinkhole, gateway and dashboard URLs, as the running process recorded them in `<LLM_FW_DIR>/llm-fw.state.json` |
| `llm-fw doctor` | Diagnose the interception setup and print a fix for anything that's off (`--json` for machine-readable output) |
| `llm-fw install-service` | Register llm-fw to auto-start at login (Task Scheduler / launchd / systemd --user), for your user only and without admin rights |
| `llm-fw uninstall-service` | Reverse `install-service` |
| `llm-fw uninstall` | Reverse `setup`: trust store, hosts file, port redirect, env vars, IDE settings and the CA. Keeps your settings, false-positive lists, audit log and licence; `--purge` deletes all but the licence, `--keep-model` keeps the model cache. See [Uninstall](client-setup.md#uninstall) |
| `llm-fw --version` | Print the installed version (`-v` and `version` work too) |

## Diagnostics (`llm-fw doctor`)

If traffic isn't being intercepted, run `llm-fw doctor` to check the whole setup at a glance. Each check is ticked (`✓`), flagged as a warning (`⚠`), or failed (`✗`) with the exact command to fix it printed underneath. It is mode-aware — `HTTPS_PROXY` is required in proxy mode but optional under the sinkhole — and exits non-zero if any check fails (handy for CI/scripts; add `--json` for machine-readable output).

What it verifies:

- **Node.js runtime** — the Node running llm-fw carries the October 2026 Node.js security release (22.23.4, 24.22.1 or 26.12.1 and newer). The proxy decompresses and TLS-verifies upstream responses on Node's own code, so an older Node is exposed to CVE-2026-111497 (Brotli decoder) from a provider response; `start` prints the same warning. An end-of-life line (23, 25) gets no fix at all.
- **Process & listeners** — `llm-fw` running, proxy + dashboard ports accepting connections, and (in sinkhole mode) the sinkhole TLS server on its HTTPS port.
- **CA** — `~/.llm-fw/ca.crt` exists and is present in the OS trust store.
- **Environment** — `HTTPS_PROXY` points at the proxy and `NODE_EXTRA_CA_CERTS` points at the llm-fw CA (required by Node.js clients like Claude Code and the SDKs). `setup` sets both persistently, but `doctor` inspects the **current shell**. When they are persisted but missing from this shell (it was opened before setup), it warns "set for new terminals, but not in this one" instead of failing: open a new terminal, or run the per-session command it prints.
- **Sinkhole plumbing** — provider hosts are redirected to `127.0.0.1` in the hosts file and the OS-level `:443` redirect is in place (Windows `netsh portproxy`, macOS `pf`, Linux `iptables`).
- **Windows only** — the **IP Helper service (`iphlpsvc`)** is running, which `netsh portproxy` depends on; if stopped, doctor prints `sc config iphlpsvc start= auto` / `net start iphlpsvc`.

```text
$ llm-fw doctor
  ✓ llm-fw process running (PID 9076)
  ✓ CA trusted in OS trust store
  ✓ HTTPS_PROXY = http://127.0.0.1:8080
  ✗ IP Helper service (iphlpsvc) not running — portproxy cannot forward :443
      ↳ sc config iphlpsvc start= auto
      ↳ net start iphlpsvc   # or: Start-Service iphlpsvc
```

## Dashboard

Open [http://localhost:7731](http://localhost:7731) while the proxy is running.

The page follows the OS light or dark scheme. The sun/moon button in the header
overrides it, and the choice is stored in the browser (localStorage), not in
`config.json`. The header also carries the mode chips (`--observe`, sinkhole,
gateway) and a live indicator for the event stream. The page loads nothing from a
third party: fonts are system stacks and every style and script is inline.

- **Events tab** — live feed of every blocked or warned request: timestamp, detection stage, risk score, cosine similarity, target API, payload preview. A filter box finds an event by id, endpoint, target or payload, and `/#event=<id>` (the link a blocked client is given) opens one directly. Expand any event to see its id, the full payload, **Record as false positive (audit only)** (audit trail, persisted to `~/.llm-fw/whitelist.json`; it does not unblock anything), and — on blocked `prompt`/`system` events — **Mark false positive (suppress future matches)**, which actually changes future behavior (see [False-Positive Suppression List](tuning.md#false-positive-suppression-list)).
- **Live Traffic tab** — throughput, service utilization and recent connections. Each connection is labelled **Inspected** (a target host: TLS-intercepted and scanned) or **Not inspected** (any other host: an end-to-end tunnel whose contents llm-fw never sees), with a count of each.
- **MCP Traffic tab** — MCP and tool-use requests that passed every check (the tools each request exposed to the model). They used to share the Events feed, where they arrived on every agent request and buried the findings; the tab label counts them.
- **Modules tab** — one card per gateway module (see [Token savings](token-savings.md)) with its on/off toggle, tokens saved, original tokens, savings ratio and requests examined (the Usage Meter shows the provider-reported input, cache reads and writes and output instead), above a live table of the requests it rewrote: target, path, tokens before and after, and the saving. Under `--observe` a row says **would save**: the request went upstream unmodified.
- **Playground tab** — test any detector (prompt injection, ASCII smuggling, RAG poisoning, DLP, MCP tools, URL/exfil, DoS) from one place, with one-click examples of what gets caught, and no real API client needed. Text categories include a **Translate** control to re-express the input in any Google-Translate-supported language and re-run the pipeline.
- **Settings tab** — every defense is toggleable live, with an inline explanation of what it does and what each mode means, grouped by category (Prompt Injection incl. many-shot/crescendo, Data & Context, Non-text, MCP, Network, DoS). An **Advanced — Tuning** group exposes the numeric knobs (heuristic/embedding thresholds, DoS rate/token limits) and the judge model as validated number/text inputs. All changes apply on the next proxy request and persist to `~/.llm-fw/config.json` — no restart.
