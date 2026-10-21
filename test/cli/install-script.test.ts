import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = process.cwd();
const SH_SCRIPT = path.join(ROOT, 'scripts', 'install.sh');
const PS1_SCRIPT = path.join(ROOT, 'scripts', 'install.ps1');

function hasCommand(cmd: string): boolean {
  const res = spawnSync(cmd, ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

function withPrependPath(dir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const pathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${dir}${path.delimiter}${env[pathKey] ?? ''}`;
  return env;
}

describe('scripts/install.ps1', () => {
  const pwsh = hasCommand('pwsh') ? 'pwsh' : hasCommand('powershell') ? 'powershell' : null;

  it('exists and is non-empty', () => {
    expect(fs.existsSync(PS1_SCRIPT)).toBe(true);
    expect(fs.statSync(PS1_SCRIPT).size).toBeGreaterThan(100);
  });

  it.runIf(Boolean(pwsh) && os.platform() === 'win32')(
    'runs npm install, llm-fw setup, and llm-fw start using mocked binaries',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-ps1-'));
      const logFile = path.join(tmp, 'calls.log');

      try {
        fs.writeFileSync(
          path.join(tmp, 'node.cmd'),
          '@echo off\r\nif "%1"=="-v" (echo v22.0.0) else (echo node %* >> "%CALL_LOG%")\r\n',
        );
        fs.writeFileSync(
          path.join(tmp, 'npm.cmd'),
          `@echo off\r\nif "%1"=="prefix" (echo ${tmp}) else (echo npm %* >> "%CALL_LOG%")\r\n`,
        );
        fs.writeFileSync(
          path.join(tmp, 'llm-fw.cmd'),
          '@echo off\r\necho llm-fw %* >> "%CALL_LOG%"\r\n',
        );

        const res = spawnSync(
          pwsh!,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_SCRIPT, '-ProxyOnly', '-Version', '0.7.0'],
          {
            env: withPrependPath(tmp, { CALL_LOG: logFile }),
            encoding: 'utf8',
          },
        );

        expect(res.status).toBe(0);
        const calls = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).map(s => s.trim());
        expect(calls).toContain('npm install -g --ignore-scripts llm-fw@0.7.0');
        expect(calls).toContain('llm-fw setup --proxy-only --no-judge');
        expect(calls).toContain('llm-fw start');
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it.runIf(Boolean(pwsh) && os.platform() === 'win32')(
    'fails when Node.js major version is below 22',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-ps1-old-'));
      try {
        fs.writeFileSync(
          path.join(tmp, 'node.cmd'),
          '@echo off\r\necho v20.11.0\r\n',
        );
        const res = spawnSync(
          pwsh!,
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1_SCRIPT],
          {
            env: withPrependPath(tmp),
            encoding: 'utf8',
          },
        );
        expect(res.status).not.toBe(0);
        expect(res.stderr + res.stdout).toMatch(/Node\.js 22\+/);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    20_000,
  );
});

describe('scripts/install.sh', () => {
  it('exists, uses LF line endings, and starts with a POSIX sh shebang', () => {
    const content = fs.readFileSync(SH_SCRIPT, 'utf8');
    expect(content.includes('\r')).toBe(false);
    expect(content.startsWith('#!/usr/bin/env sh')).toBe(true);
    expect(content).toContain('npm install -g --ignore-scripts');
    expect(content).toContain('sudo env "PATH=$NODE_DIR:$PATH"');
  });

  it.runIf(os.platform() !== 'win32')(
    'runs npm install, setup, and start via POSIX sh with mocked binaries',
    () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fw-sh-'));
      const logFile = path.join(tmp, 'calls.log');

      try {
        const writeExe = (name: string, body: string) => {
          const p = path.join(tmp, name);
          fs.writeFileSync(p, `#!/usr/bin/env sh\n${body}\n`, { mode: 0o755 });
        };

        writeExe(
          'node',
          'if [ "$1" = "-v" ]; then echo v22.0.0; else echo "node $*" >> "$CALL_LOG"; fi',
        );
        writeExe(
          'npm',
          `if [ "$1" = "prefix" ]; then echo "${tmp}"; else echo "npm $*" >> "$CALL_LOG"; fi`,
        );
        fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
        const binPath = path.join(tmp, 'bin', 'llm-fw');
        fs.writeFileSync(binPath, '#!/usr/bin/env sh\n', { mode: 0o755 });

        const res = spawnSync(
          'sh',
          [SH_SCRIPT, '--proxy-only', '--version', '0.7.0'],
          {
            env: {
              ...process.env,
              CALL_LOG: logFile,
              PATH: `${tmp}:${path.join(tmp, 'bin')}:${process.env.PATH ?? ''}`,
            },
            encoding: 'utf8',
          },
        );

        expect(res.status).toBe(0);
        const calls = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        expect(calls).toContain('npm install -g --ignore-scripts llm-fw@0.7.0');
        expect(calls.some(c => c.includes('setup --proxy-only --no-judge'))).toBe(true);
        expect(calls.some(c => c.endsWith(' start'))).toBe(true);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
  );
});
