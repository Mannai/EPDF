import { win32 } from 'node:path'

/**
 * Windows programs Epdf runs, by absolute path in System32, so a PATH entry or a file in the current folder can never
 * stand in for them. These are Windows paths whatever platform builds them (the commands only ever run on Windows).
 */

const systemRoot = (env: NodeJS.ProcessEnv): string => env['SystemRoot'] ?? env['windir'] ?? 'C:\\Windows'

/** Windows PowerShell 5.1, which ships with every supported Windows. */
export function powershellPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

/** `icacls`, which lists a file's access control entries (used to tell whether a file has its own permissions). */
export function icaclsPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(systemRoot(env), 'System32', 'icacls.exe')
}

/**
 * The arguments every PowerShell call starts with. There is deliberately no `-ExecutionPolicy Bypass`: Epdf only
 * passes fixed commands with `-Command` / `-EncodedCommand`, which the execution policy does not govern (it applies
 * to script files), so the machine's policy is left alone, including a stricter one set by an administrator.
 */
export const POWERSHELL_ARGS: readonly string[] = ['-NoProfile', '-NonInteractive']
