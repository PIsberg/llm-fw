import fs from 'node:fs'
import { dirname, posix } from 'node:path'
import { homedir, platform } from 'node:os'
import { execFileSync } from 'node:child_process'

/**
 * `llm-fw install-service` / `llm-fw uninstall-service` — register/remove an
 * OS-level auto-start entry that runs `llm-fw start` at login, so the proxy
 * comes back up after every reboot without the user remembering to run it.
 *
 * Mirrors doctor.ts's split: pure "what should happen" builders (buildInstallPlan/
 * buildUninstallPlan/resolveInvocation/buildLaunchdPlist/buildSystemdUnit) that
 * return a plan (files to write + commands to run) with ZERO side effects, and
 * a thin executor (installService/uninstallService, plus execCommand/writeFile
 * below) that performs it. The plan builders are what tests exercise directly;
 * the executor is only invoked when a user runs the subcommand for real, and
 * even then every OS call goes through execFileSync/fs so it stays mockable.
 */

export type OS = 'win32' | 'darwin' | 'linux'

function isSupportedOs(p: NodeJS.Platform): p is OS {
  return p === 'win32' || p === 'darwin' || p === 'linux'
}

/** The node binary + script args that re-launch this exact CLI with `start`. */
export interface Invocation {
  /** The executable to run — the node binary currently executing this CLI. */
  command: string
  /** Arguments to `command`: the script path node was invoked with, then 'start'. */
  args: string[]
}

/**
 * Resolve the exact command that re-launches this same CLI with `start`.
 * Uses `process.execPath` (the node binary running right now) + `process.argv[1]`
 * (the script path node was given) — this is agnostic to whether the process
 * was started via the npm-installed `llm-fw` bin (dist/cli/index.js) or via
 * `tsx src/cli/index.ts` in dev, and needs no new dependency or PATH lookup to
 * discover. Parameters are injectable so tests never touch the real process.
 */
export function resolveInvocation(
  execPath: string = process.execPath,
  scriptPath: string = process.argv[1] ?? '',
): Invocation {
  return { command: execPath, args: [scriptPath, 'start'] }
}

export const TASK_NAME = 'llm-fw'
export const LAUNCHD_LABEL = 'dev.llmfw'
export const SYSTEMD_UNIT = 'llm-fw.service'

export interface CommandSpec {
  cmd: string
  args: string[]
}

export interface FileSpec {
  path: string
  contents: string
}

export interface ServicePlan {
  /** Files to write before running `commands` (empty on Windows — schtasks needs none). */
  files: FileSpec[]
  /** Commands to execute, in order. */
  commands: CommandSpec[]
}

export interface UninstallPlan {
  /** Commands to execute, in order. Each is best-effort — failure (e.g. "never installed") does not abort the rest. */
  commands: CommandSpec[]
  /** Files to delete after running `commands`, if present. */
  filesToDelete: string[]
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** The quoted `/TR` value schtasks expects: a single string embedding the quoted exe + its quoted args. */
function schtasksTr(inv: Invocation): string {
  return [inv.command, ...inv.args].map(part => `"${part}"`).join(' ')
}

/**
 * A per-user LaunchAgent plist. RunAtLoad fires it once the agent is loaded —
 * for a LaunchAgent (as opposed to a LaunchDaemon) that happens at login,
 * matching Windows ONLOGON / systemd's default.target. KeepAlive is false:
 * `llm-fw start` already self-heals (see start.ts) and re-running it endlessly
 * on crash-loop would fight that. stdout/stderr are captured to
 * ~/Library/Logs since launchd otherwise discards them.
 */
export function buildLaunchdPlist(inv: Invocation, home: string = homedir()): string {
  const argsXml = [inv.command, ...inv.args]
    .map(a => `        <string>${escapeXml(a)}</string>`)
    .join('\n')
  const logDir = posix.join(home, 'Library', 'Logs')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${argsXml}
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>StandardOutPath</key>
    <string>${posix.join(logDir, 'llm-fw.out.log')}</string>
    <key>StandardErrorPath</key>
    <string>${posix.join(logDir, 'llm-fw.err.log')}</string>
</dict>
</plist>
`
}

/**
 * A per-user systemd unit under ~/.config/systemd/user. `WantedBy=default.target`
 * is the user-session equivalent of "start at login"; `Restart=on-failure` gives
 * a small amount of crash resilience without fighting start.ts's own self-heal.
 */
export function buildSystemdUnit(inv: Invocation): string {
  const execStart = [inv.command, ...inv.args].map(a => `"${a}"`).join(' ')
  return `[Unit]
Description=llm-fw prompt injection firewall

[Service]
ExecStart=${execStart}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`
}

/** Absolute path of the macOS LaunchAgent plist llm-fw installs. */
export function launchdPlistPath(home: string = homedir()): string {
  // Always POSIX separators: this path only ever describes a real macOS host
  // (buildInstallPlan is invoked with the CURRENT platform() at runtime), and
  // using path.posix here (rather than the host-native `join`) keeps the pure
  // builder's output deterministic when exercised from tests on any dev OS.
  return posix.join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
}

/** Absolute path of the Linux user systemd unit llm-fw installs. */
export function systemdUnitPath(home: string = homedir()): string {
  return posix.join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

/**
 * Pure "what should happen" builder for `install-service`: no fs/process
 * access, just the plan. `os` and `home` are injectable so every platform's
 * plan can be exercised from a single test process.
 */
export function buildInstallPlan(os: OS, inv: Invocation, home: string = homedir()): ServicePlan {
  switch (os) {
    case 'win32':
      return {
        files: [],
        commands: [{
          cmd: 'schtasks',
          args: ['/Create', '/TN', TASK_NAME, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F', '/TR', schtasksTr(inv)],
        }],
      }
    case 'darwin': {
      const plistPath = launchdPlistPath(home)
      return {
        files: [{ path: plistPath, contents: buildLaunchdPlist(inv, home) }],
        commands: [{ cmd: 'launchctl', args: ['load', plistPath] }],
      }
    }
    case 'linux': {
      const unitPath = systemdUnitPath(home)
      return {
        files: [{ path: unitPath, contents: buildSystemdUnit(inv) }],
        commands: [
          { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
          { cmd: 'systemctl', args: ['--user', 'enable', '--now', SYSTEMD_UNIT] },
        ],
      }
    }
  }
}

/** Pure "what should happen" builder for `uninstall-service` — reverses buildInstallPlan. */
export function buildUninstallPlan(os: OS, home: string = homedir()): UninstallPlan {
  switch (os) {
    case 'win32':
      return {
        commands: [{ cmd: 'schtasks', args: ['/Delete', '/TN', TASK_NAME, '/F'] }],
        filesToDelete: [],
      }
    case 'darwin': {
      const plistPath = launchdPlistPath(home)
      return {
        commands: [{ cmd: 'launchctl', args: ['unload', plistPath] }],
        filesToDelete: [plistPath],
      }
    }
    case 'linux': {
      const unitPath = systemdUnitPath(home)
      return {
        commands: [
          { cmd: 'systemctl', args: ['--user', 'disable', '--now', SYSTEMD_UNIT] },
          { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
        ],
        filesToDelete: [unitPath],
      }
    }
  }
}

function describeOs(os: OS): string {
  if (os === 'win32') return 'Windows Task Scheduler'
  if (os === 'darwin') return 'macOS launchd'
  return 'Linux systemd (user)'
}

/** Guidance printed when registration/removal fails — usually a rights or environment issue, not a bug. */
function elevationHint(os: OS): string {
  if (os === 'win32') {
    return 'This creates a per-user logon task and normally needs no elevation. If it still failed, try an Administrator terminal and retry.'
  }
  if (os === 'darwin') {
    return 'Check that ~/Library/LaunchAgents is writable and that launchctl is on PATH (no sudo needed for a per-user LaunchAgent).'
  }
  return 'Check that ~/.config/systemd/user is writable and "systemctl --user" works — it needs an active user session (on a headless server, run: loginctl enable-linger $USER).'
}

// ── executor (impure — only reached from install()/uninstall() below) ───────

/** Runs one planned command. Never throws — failures are reported to the caller as a result value. */
function execCommand(spec: CommandSpec): { ok: boolean; error?: string } {
  try {
    execFileSync(spec.cmd, spec.args, { stdio: 'pipe' })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function writeFile(spec: FileSpec): void {
  fs.mkdirSync(dirname(spec.path), { recursive: true })
  fs.writeFileSync(spec.path, spec.contents, 'utf8')
}

/**
 * `llm-fw install-service` — the ONLY place in this module that actually
 * registers anything. Everything above this line is pure plan-building; this
 * function is what turns a plan into real schtasks/launchctl/systemctl calls
 * and real file writes, and it runs ONLY when a user explicitly invokes this
 * subcommand (wired from cli/index.ts).
 */
export function installService(_args: string[] = []): void {
  const os = platform()
  if (!isSupportedOs(os)) {
    console.error(`llm-fw install-service: unsupported platform "${os}".`)
    console.error('Supported: Windows, macOS, Linux. Run "llm-fw start" manually, or add your own OS-level autostart entry.')
    process.exitCode = 1
    return
  }

  const inv = resolveInvocation()
  const plan = buildInstallPlan(os, inv)

  console.log(`llm-fw install-service — registering ${describeOs(os)} auto-start...`)
  console.log(`  Command: ${[inv.command, ...inv.args].join(' ')}`)

  try {
    for (const file of plan.files) {
      writeFile(file)
      console.log(`  Wrote ${file.path}`)
    }
    for (const cmd of plan.commands) {
      const result = execCommand(cmd)
      if (!result.ok) throw new Error(`${cmd.cmd} ${cmd.args.join(' ')} failed: ${result.error}`)
    }
  } catch (err) {
    console.error(`\nCould not register the auto-start entry: ${err instanceof Error ? err.message : String(err)}`)
    console.error(elevationHint(os))
    process.exitCode = 1
    return
  }

  console.log(`\nllm-fw will now start automatically at login. Run "llm-fw uninstall-service" to reverse this.`)
}

/**
 * `llm-fw uninstall-service` — reverses install-service. Best-effort: each
 * step is attempted independently (e.g. it's fine if the task/agent/unit was
 * never installed) and a warning is printed rather than aborting the rest.
 */
export function uninstallService(_args: string[] = []): void {
  const os = platform()
  if (!isSupportedOs(os)) {
    console.error(`llm-fw uninstall-service: unsupported platform "${os}".`)
    process.exitCode = 1
    return
  }

  const plan = buildUninstallPlan(os)
  console.log(`llm-fw uninstall-service — removing ${describeOs(os)} auto-start...`)

  let anyFailed = false
  for (const cmd of plan.commands) {
    const result = execCommand(cmd)
    if (!result.ok) {
      anyFailed = true
      console.warn(`  (skip) ${cmd.cmd} ${cmd.args.join(' ')}: ${result.error}`)
    }
  }
  for (const filePath of plan.filesToDelete) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
        console.log(`  Removed ${filePath}`)
      }
    } catch (err) {
      anyFailed = true
      console.warn(`  Could not remove ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  if (anyFailed) {
    console.warn(`\nSome steps could not be completed — the service may never have been installed, or you may lack rights.`)
    console.warn(elevationHint(os))
  } else {
    console.log('\nAuto-start entry removed.')
  }
}
