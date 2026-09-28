import { existsSync } from 'node:fs'

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
