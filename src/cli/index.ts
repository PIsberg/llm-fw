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
  case '--version':
  case '-v':
  case 'version': {
    // package.json sits two levels up from both src/cli and dist/cli.
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(`llm-fw ${pkg.version}`);
    break;
  }
  default: {
    const { USAGE } = await import('./usage.js');
    console.log(USAGE);
    // Asking for help is success; only an unrecognised command is an error.
    const askedForHelp = !command || command === '--help' || command === '-h' || command === 'help';
    process.exit(askedForHelp ? 0 : 1);
  }
}
