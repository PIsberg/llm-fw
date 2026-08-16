[llm-fw](../../README.md) > [Documentation](../README.md) > CLI reference

# CLI reference

Every command and flag, the built-in diagnostics, and the dashboard.

## CLI reference

| Command | Description |
|---------|-------------|
| `llm-fw setup` | Generate CA cert, install to trust store, download model, set `HTTPS_PROXY` + `NODE_EXTRA_CA_CERTS` (user env / shell profile), auto-configure the proxy in detected VS Code / Antigravity IDE settings, and enable the sinkhole when run with admin/root (covers both proxy and Node.js/native tools) |
| `llm-fw setup --proxy-only` | Skip the sinkhole; configure proxy mode only (no admin needed) |
| `llm-fw setup-judge` | Install Ollama model and enable Stage 3 judge |
| `llm-fw start` | Start proxy and dashboard |
| `llm-fw stop` | Stop processes; restore hosts file if sinkhole mode |
| `llm-fw status` | Show running state, active mode, dashboard URL |
| `llm-fw doctor` | Diagnose the interception setup and print a fix for anything that's off (`--json` for machine-readable output) |
| `llm-fw install-service` | Register llm-fw to auto-start at login (Task Scheduler / launchd / systemd --user) |
| `llm-fw uninstall-service` | Reverse `install-service` |

## Diagnostics (`llm-fw doctor`)

If traffic isn't being intercepted, run `llm-fw doctor` to check the whole setup at a glance. Each check is ticked (`✓`), flagged as a warning (`⚠`), or failed (`✗`) with the exact command to fix it printed underneath. It is mode-aware — `HTTPS_PROXY` is required in proxy mode but optional under the sinkhole — and exits non-zero if any check fails (handy for CI/scripts; add `--json` for machine-readable output).

What it verifies:

- **Process & listeners** — `llm-fw` running, proxy + dashboard ports accepting connections, and (in sinkhole mode) the sinkhole TLS server on its HTTPS port.
- **CA** — `~/.llm-fw/ca.crt` exists and is present in the OS trust store.
- **Environment** — `HTTPS_PROXY` points at the proxy and `NODE_EXTRA_CA_CERTS` points at the llm-fw CA (required by Node.js clients like Claude Code and the SDKs). `setup` sets both persistently, but `doctor` inspects the **current shell**, so if it reports them unset right after install, just open a new terminal (or run the per-session export it prints).
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

- **Events tab** — live feed of every blocked or warned request: timestamp, detection stage, risk score, cosine similarity, target API, payload preview. Expand any event to see the full payload, **Mark as false positive** (audit trail, persisted to `~/.llm-fw/whitelist.json`), and — on blocked `prompt`/`system` events — **Mark false positive (suppress future matches)**, which actually changes future behavior (see [False-Positive Suppression List](tuning.md#false-positive-suppression-list)).
- **Playground tab** — test any detector (prompt injection, ASCII smuggling, RAG poisoning, DLP, MCP tools, URL/exfil, DoS) from one place, with one-click examples of what gets caught, and no real API client needed. Text categories include a **Translate** control to re-express the input in any Google-Translate-supported language and re-run the pipeline.
- **Settings tab** — every defense is toggleable live, with an inline explanation of what it does and what each mode means, grouped by category (Prompt Injection incl. many-shot/crescendo, Data & Context, Non-text, MCP, Network, DoS). An **Advanced — Tuning** group exposes the numeric knobs (heuristic/embedding thresholds, DoS rate/token limits) and the judge model as validated number/text inputs. All changes apply on the next proxy request and persist to `~/.llm-fw/config.json` — no restart.
