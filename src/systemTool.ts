import { win32 } from 'node:path'

/**
 * Windows system tools the CLI runs. Each lives in `%SystemRoot%\System32`.
 */
const WINDOWS_TOOLS: ReadonlySet<string> = new Set(['certutil', 'icacls', 'net', 'netsh', 'netstat', 'reg', 'sc', 'schtasks', 'setx'])

/**
 * `name` as the CLI should run it: a Windows system tool by its absolute path,
 * anything else unchanged. A bare name is looked up in the working directory
 * before PATH, by cmd.exe (which `execSync` uses on Windows) and by Node's own
 * lookup alike, unless `NoDefaultCurrentDirectoryInExePath` is set, so a
 * `certutil.bat` or `reg.exe` in the folder `llm-fw setup` was started from,
 * usually elevated, ran in place of the real one (GHSA-rhc4-5qxh-r96m). A
 * missing or relative `SystemRoot` falls back to `C:\Windows` rather than to a
 * lookup.
 */
export function systemTool(name: string, os: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (os !== 'win32' || !WINDOWS_TOOLS.has(name)) return name
  const root = env.SystemRoot
  return win32.join(root && win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', `${name}.exe`)
}

/**
 * Turns off the Windows lookup of a program in the working directory, for this
 * process and every program it starts. cmd.exe (`execSync`) and Node's own
 * lookup (`execFileSync`, `spawn`) both try the working directory before PATH
 * unless the CALLING process sets `NoDefaultCurrentDirectoryInExePath`: in a
 * child's `env` it changes nothing. `systemTool` names the system tools by
 * path; this covers the programs that live elsewhere (ollama, lean-ctx), whose
 * copy in the folder llm-fw was started from ran in their place
 * (GHSA-rhc4-5qxh-r96m). Node reads it from libuv 1.48 on, which every Node the
 * package supports bundles. Call it before anything can start a program.
 */
export function noWorkingDirectoryLookup(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = process.platform): void {
  if (os === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1'
}
