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
`);
    process.exit(command ? 1 : 0);
  }
}
