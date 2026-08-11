# Security policy

llm-fw is a local prompt-injection firewall. It terminates TLS for the traffic it
inspects, holds a locally generated CA, and serves an operator dashboard on
loopback. A defect in any of those is a defect in a security boundary, so
reports are welcome.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest published
`0.x` release is supported; there are no backports to earlier `0.x` lines.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | yes       |
| < 0.4   | no        |

## Reporting a vulnerability

Report privately through GitHub, at
<https://github.com/PIsberg/llm-fw/security/advisories/new>. That opens a draft
advisory visible only to the maintainers.

Do not open a public issue for a vulnerability. Public issues are the right
place for everything else, including hardening ideas that do not describe a
working attack.

Useful in a report:

- the version (`npm ls -g llm-fw`) and the operating system,
- the configuration involved, with any keys redacted,
- what an attacker gains, and what access they need to start,
- a reproduction: a request, a config, or a short script.

## What to expect

- Acknowledgement within 5 working days.
- An assessment, with a severity and a rough fix timeline, within 10 working
  days.
- A fix released as a patch version, and a published GitHub advisory once the
  fix is available. Reporters are credited unless they ask not to be.

This is a small project maintained by one person; those are targets, not a
contractual SLA.

## Scope

In scope:

- bypassing the detection pipeline so a payload the firewall claims to block
  reaches the upstream model,
- leaking inspected traffic, prompts, API keys, or the generated CA private key,
- anything reachable from the network on the proxy or dashboard listener,
- privilege escalation through the CLI, the installed service, or the licence
  check.

Out of scope:

- missing detections on novel injection phrasings. Detection is heuristic and
  probabilistic; a payload that scores below the threshold is a tuning issue, so
  open a normal issue with the payload.
- attacks that need an attacker who already has local code execution as the user
  running llm-fw,
- advisories against dependencies with no reachable path from llm-fw's code,
- reports produced only by a scanner, without a demonstrated impact.

## Security-relevant defaults

Worth knowing before reporting, and worth checking in your own deployment:

- The proxy (`127.0.0.1:8080`) and the dashboard (`127.0.0.1:7731`) bind to
  loopback by default. `start --standalone`, or setting `bindHost`, exposes
  plaintext of everything being inspected to the network.
- The CA private key lives under the llm-fw data directory (`~/.llm-fw` unless
  `LLM_FW_DIR` says otherwise). Anything that can read it can impersonate every
  host the proxy intercepts.
- A loopback caller bypasses the dashboard's token auth entirely. Mutating
  endpoints are protected only by a same-origin check, so any local process, and
  any page that can forge an acceptable `Origin`, is inside that boundary. The
  token gate applies to non-loopback callers.
