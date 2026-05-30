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
    await run();
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
  default: {
    console.log(`Usage: llm-fw <command> [options]

Commands:
  setup [--sinkhole]   Set up the firewall (use --sinkhole for sinkhole mode)
  start                Start the firewall proxy
  stop                 Stop the firewall proxy
  status               Show firewall status
`);
    process.exit(command ? 1 : 0);
  }
}
