/**
 * Cloud "files on demand" placeholders (OneDrive, Dropbox online-only, Google Drive streaming, iCloud Drive):
 * the directory entry exists with the real size, but the content is not on this machine, and reading it makes
 * the sync client download it. The indexer must never do that, so it recognises placeholders from metadata
 * alone (`stat`/attributes never trigger a download) and skips them.
 *
 * Windows: Node does not expose file attributes, so a file whose `stat` says "size > 0 but no disk blocks
 * allocated" is a *suspect*, and the attribute word is then read with PowerShell (`Get-Item` does not hydrate).
 * macOS/Linux: a dataless file has size > 0 and zero blocks; iCloud Drive also leaves `.Name.pdf.icloud` stubs.
 */

export const FILE_ATTRIBUTE = {
  READONLY: 0x1,
  HIDDEN: 0x2,
  SYSTEM: 0x4,
  DIRECTORY: 0x10,
  SPARSE_FILE: 0x200,
  REPARSE_POINT: 0x400,
  OFFLINE: 0x1000,
  /** Also set by OneDrive/Dropbox on files that must be recalled (downloaded) when opened. */
  RECALL_ON_OPEN: 0x40000,
  /** The "cloud only" marker of files-on-demand. */
  RECALL_ON_DATA_ACCESS: 0x400000
} as const

/** True if a Windows attribute word says the file's content is not local. */
export function isPlaceholderAttributes(attrs: number): boolean {
  if (!Number.isFinite(attrs) || attrs < 0) return false
  return (attrs & (FILE_ATTRIBUTE.OFFLINE | FILE_ATTRIBUTE.RECALL_ON_OPEN | FILE_ATTRIBUTE.RECALL_ON_DATA_ACCESS)) !== 0
}

export type PlaceholderVerdict = 'local' | 'suspect'

/**
 * First, metadata-only pass. NTFS stores files below roughly 700 bytes inside the MFT record (no blocks), so tiny
 * files are never suspects; every PDF of a real size has blocks unless its content is not here.
 */
export function placeholderSuspicion(stat: { size: number; blocks?: number }): PlaceholderVerdict {
  if (typeof stat.blocks !== 'number') return 'local'
  return stat.size >= 1024 && stat.blocks === 0 ? 'suspect' : 'local'
}

/** iCloud Drive leaves `.Report.pdf.icloud` for a file that is not downloaded. Returns the real name, or null. */
export function icloudStubName(fileName: string): string | null {
  const m = /^\.(.+)\.icloud$/i.exec(fileName)
  return m && /\.pdf$/i.test(m[1]) ? m[1] : null
}

/**
 * Decides whether a suspect is a placeholder. `attrs` is the Windows attribute word (null when it could not
 * be read). Where attributes do not exist (macOS, Linux) or could not be read, a suspect counts as a
 * placeholder: skipping a local file costs nothing, downloading gigabytes from the cloud does.
 */
export function resolveSuspect(platform: string, attrs: number | null): boolean {
  if (platform === 'win32' && attrs !== null && attrs >= 0) return isPlaceholderAttributes(attrs)
  return true
}
