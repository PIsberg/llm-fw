#!/usr/bin/env node
const command = process.argv[2];
const args = process.argv.slice(3);

switch (command) {
  case 'setup': {
    const { run } = await import('./setup.js');
    await run(args);
    break;
  }
  case 'start': {
    const { run } = await import('./start.js');
    await run(args);
    break;
  }
  case 'stop': {
    const { run } = await import('./stop.js');
    await run();
    break;
  }
  case 'status': {
    const { run } = await import('./status.js');
    await run();
    break;
  }
  case 'doctor':
  case '--doctor': {
    const { run } = await import('./doctor.js');
    await run(args);
    break;
  }
  case 'setup-judge': {
    const { run } = await import('./setup-judge.js');
    await run();
    break;
  }
  case 'uninstall': {
    const { run } = await import('./uninstall.js');
    await run(args);
    break;
  }
  case 'install-service': {
    const { installService } = await import('./service.js');
    installService(args);
    break;
  }
  case 'uninstall-service': {
    const { uninstallService } = await import('./service.js');
    uninstallService(args);
    break;
  }
  case 'license': {
    const { run } = await import('./license.js');
    await run(args);
    break;
  }
  default: {
    console.log(`Usage: llm-fw <command> [options]

Commands:
  setup [--proxy-only]  Set up the firewall. Enables BOTH proxy and sinkhole by
    [--judge|--no-judge]  default (sinkhole needs admin/root); --proxy-only skips
                        the sinkhole and covers only HTTPS_PROXY-aware tools.
                        --judge/--no-judge answers the Stage 3 prompt up front
                        (it is auto-skipped when stdin is not interactive).
  setup-judge           Install an Ollama model and enable Stage 3 judge
  uninstall [--yes]     Reverse setup: remove the CA from the OS trust store,
    [--keep-model]      restore the hosts file, delete the :443 port redirect,
                        and clear ~/.llm-fw. --yes skips the prompt; --keep-model
                        preserves the cached embedding model.
  start                 Start the firewall proxy
    [--standalone]      Run as a shared server: bind the proxy (and dashboard +
                        CA download) to all interfaces so other machines can use
                        this host as their LLM proxy. Disables the local sinkhole.
  stop                  Stop the firewall proxy
  status                Show firewall status
  doctor [--json]       Diagnose the interception setup (CA, env vars, proxy,
                        sinkhole hosts/redirect, iphlpsvc) and print fixes
  install-service        Register llm-fw to start automatically at login
                        (Windows Task Scheduler / macOS launchd / Linux
                        systemd --user)
  uninstall-service      Reverse install-service
  license                Print the licence terms and this machine's status
    [--activate <key>]  Store a licence key bought at https://deversity.se/llmfw
    [--deactivate]      Remove the stored key
    [--activate-file <path>]  Store an offline licence file (a licence issued
                        directly, no Keygen account or Paddle purchase needed)
    [--deactivate-file] Remove the stored offline licence file
    [--status]          Print the licence state only
    [--verify]          Check the key with Keygen (the only licensing network
                        call llm-fw ever makes; everything else is offline)

Licensed under the PolyForm Noncommercial License 1.0.0. Noncommercial use is
free. Commercial use is not granted by that licence and needs a separate one:
https://deversity.se/llmfw or peter.isberg@deversity.se — run
\`llm-fw license\` for the details.
`);
    process.exit(command ? 1 : 0);
  }
}
