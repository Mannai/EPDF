import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the optional cross-checking tools are (tests only; the product never needs them): an environment variable,
 * else the usual install location on this platform. Tests that use a tool skip when it is not there.
 */
const first = (candidates: (string | undefined)[]): string =>
  candidates.find((p): p is string => !!p && existsSync(p)) ?? candidates.find((p): p is string => !!p)!

export const SOFFICE = first([
  process.env['EPDF_TOOL_SOFFICE'],
  ...(process.platform === 'win32'
    ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe']
    : process.platform === 'darwin'
      ? ['/Applications/LibreOffice.app/Contents/MacOS/soffice']
      : ['/usr/bin/soffice', '/usr/local/bin/soffice', '/opt/libreoffice/program/soffice'])
])

export const QPDF = first([
  process.env['EPDF_TOOL_QPDF'],
  process.env['QPDF'],
  ...(process.platform === 'win32' ? ['C:\\Program Files\\qpdf 12.4.1\\bin\\qpdf.exe'] : ['/usr/bin/qpdf', '/usr/local/bin/qpdf', '/opt/homebrew/bin/qpdf'])
])

export const HAVE_SOFFICE = existsSync(SOFFICE)
export const HAVE_QPDF = existsSync(QPDF)

/**
 * Whether these font families are installed on this system (not just substituted). LibreOffice is a fair layout
 * reference only with a document's own fonts: with substitutes (Liberation, DejaVu) its line widths and indents differ.
 */
export function systemHasFonts(families: string[]): boolean {
  if (process.platform === 'win32') {
    const files: Record<string, string> = { Arial: 'arial.ttf', 'Times New Roman': 'times.ttf', Calibri: 'calibri.ttf', 'Segoe UI': 'segoeui.ttf' }
    const dir = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'Fonts')
    return families.every((f) => !!files[f] && existsSync(join(dir, files[f]!)))
  }
  try {
    const installed = new Set(execFileSync('fc-list', [':', 'family'], { encoding: 'utf8' }).split('\n').flatMap((l) => l.split(',')).map((s) => s.trim()))
    return families.every((f) => installed.has(f))
  } catch {
    return false
  }
}
