import { win32 } from 'node:path'

/**
 * Windows system tools the CLI runs. Each lives in `%SystemRoot%\System32`.
 */
const WINDOWS_TOOLS: ReadonlySet<string> = new Set(['certutil', 'icacls', 'net', 'netsh', 'netstat', 'reg', 'sc', 'schtasks', 'setx'])

/**
 * `name` as the CLI should run it: a Windows system tool by its absolute path,
 * anything else unchanged. A bare name is looked up through PATH, and a shell
 * (cmd.exe, which `execSync` uses on Windows) looks in the working directory
 * first unless `NoDefaultCurrentDirectoryInExePath` is set, so a `certutil.bat`
 * in the folder `llm-fw setup` was started from, usually elevated, ran in place
 * of the real one. A missing or relative `SystemRoot` falls back to
 * `C:\Windows` rather than to a lookup.
 */
export function systemTool(name: string, os: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (os !== 'win32' || !WINDOWS_TOOLS.has(name)) return name
  const root = env.SystemRoot
  return win32.join(root && win32.isAbsolute(root) ? root : 'C:\\Windows', 'System32', `${name}.exe`)
}
