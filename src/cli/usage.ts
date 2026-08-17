/**
 * `llm-fw --help` output.
 *
 * Kept in its own module so `test/cli/usage.test.ts` can assert that every
 * dispatched subcommand and every real flag appears here. `--gateway` and
 * `--observe` were both shipped, tested and documented in the README while
 * being absent from this text, so the only way to discover them was to read
 * the source. Help output is the first place anyone looks.
 */
export const USAGE = `Usage: llm-fw <command> [options]

Commands:
  setup [--proxy-only]  Set up the firewall. Enables BOTH proxy and sinkhole by
    [--sinkhole]        default (sinkhole needs admin/root); --proxy-only skips
    [--judge|--no-judge]  the sinkhole and covers only HTTPS_PROXY-aware tools,
                        --sinkhole requires it and fails if not elevated.
                        --judge/--no-judge answers the Stage 3 prompt up front
                        (it is auto-skipped when stdin is not interactive).
                        Also persists HTTPS_PROXY, NO_PROXY and
                        NODE_EXTRA_CA_CERTS for new shells.
  setup-judge           Install an Ollama model and enable Stage 3 judge
  uninstall [--yes]     Reverse setup: remove the CA from the OS trust store,
    [--keep-model]      restore the hosts file, delete the :443 port redirect,
                        and clear ~/.llm-fw. --yes skips the prompt; --keep-model
                        preserves the cached embedding model.
  start                 Start the firewall proxy (HTTPS via CONNECT; set
                        HTTPS_PROXY, not HTTP_PROXY)
    [--standalone]      Run as a shared server: bind the proxy (and dashboard +
                        CA download) to all interfaces so other machines can use
                        this host as their LLM proxy. Disables the local sinkhole.
                        Clients need the CA and, off-host, a proxy token.
    [--gateway]         Also start the reverse-proxy gateway: clients set their
                        SDK base_url instead of installing a CA. Binds loopback
                        unless combined with --standalone or LLM_FW_GATEWAY_BIND.
    [--observe]         Observation mode: run every detector and record what
                        would have been blocked, without refusing anything.
                        DoS quotas, the loop breaker and client auth still apply.
  stop                  Stop the firewall proxy
  status                Show firewall status
  doctor [--json]       Diagnose the interception setup (CA, env vars, proxy,
                        sinkhole hosts/redirect, iphlpsvc) and print fixes
  install-service        Register llm-fw to start automatically at login
                        (Windows Task Scheduler / macOS launchd / Linux
                        systemd --user). Registers a plain "start" with no
                        flags: configure server mode with LLM_FW_* env vars.
  uninstall-service      Reverse install-service
  license                Print the licence terms and this machine's status
    [--activate <key>]  Store a licence key bought at https://deversity.se/llmfw/
    [--deactivate]      Remove the stored key
    [--activate-file <path>]  Store an offline licence file (a licence issued
                        directly, no Keygen account or Paddle purchase needed)
    [--deactivate-file] Remove the stored offline licence file
    [--status]          Print the licence state only
    [--verify]          Check the key with Keygen (the only licensing network
                        call llm-fw ever makes; everything else is offline)

Licensed under the PolyForm Noncommercial License 1.0.0. Noncommercial use is
free. Commercial use is not granted by that licence and needs a separate one:
https://deversity.se/llmfw/ or peter.isberg@deversity.se — run
"llm-fw license" for the details.
`;
