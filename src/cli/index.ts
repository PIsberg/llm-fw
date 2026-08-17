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
    const { USAGE } = await import('./usage.js');
    console.log(USAGE);
    process.exit(command ? 1 : 0);
  }
}
