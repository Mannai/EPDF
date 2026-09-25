import { readdir, realpath, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { isInside, relativeDir, type ScanEntry } from '../../../shared/features/library/plan'
import { icloudStubName, placeholderSuspicion, resolveSuspect } from '../../../shared/features/library/placeholder'

/**
 * Walks a watched folder for PDFs. Runs in the index worker. Guarantees:
 *  - never follows a link out of the folder, never visits a directory twice (symlink/junction loops)
 *  - skips hidden folders, system folders and dependency folders
 *  - bounded depth and file count (the result says when a cap was hit)
 *  - only `stat`s files: cloud placeholders are recognised without reading (and so without downloading) them
 *  - yields to the event loop regularly and stops promptly when aborted
 */

export interface ScanOptions {
  maxDepth: number
  maxFiles: number
  signal?: AbortSignal
  onProgress?: (filesFound: number, dir: string) => void
  /** Reads Windows attribute words for placeholder suspects; `null` per path when unknown. Default: none. */
  readAttributes?: (paths: string[]) => Promise<Map<string, number | null>>
  platform?: string
}

export interface ScanResult {
  /** False when the folder itself cannot be read (missing drive, deleted, no permission). */
  rootOk: boolean
  rootError?: string
  entries: ScanEntry[]
  truncated: boolean
  depthCapped: boolean
  unreadable: number
  skippedLinks: number
  /** Human-readable summary of everything that was skipped (empty when nothing was). */
  note: string
}

const SKIP_DIR_NAMES = new Set(['node_modules', '$recycle.bin', 'system volume information', 'appdata', '$windows.~bt', 'lost+found'])

export const isSkippedDirName = (name: string): boolean => name.startsWith('.') || SKIP_DIR_NAMES.has(name.toLowerCase())

const isPdfName = (name: string): boolean => /\.pdf$/i.test(name)

const yieldToLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('Cancelled')
}

export async function scanFolder(root: string, opts: ScanOptions): Promise<ScanResult> {
  const platform = opts.platform ?? process.platform
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const result: ScanResult = { rootOk: true, entries: [], truncated: false, depthCapped: false, unreadable: 0, skippedLinks: 0, note: '' }

  let rootReal: string
  try {
    rootReal = await realpath(root)
    if (!(await stat(rootReal)).isDirectory()) throw new Error('This is not a folder.')
  } catch (err) {
    return { ...result, rootOk: false, rootError: (err as NodeJS.ErrnoException).code === 'ENOENT' ? 'The folder does not exist (or its drive is not connected).' : ((err as Error).message || 'The folder cannot be read.') }
  }

  const visited = new Set<string>([caseInsensitive ? rootReal.toLowerCase() : rootReal])
  const suspects: ScanEntry[] = []
  const stack: { dir: string; depth: number }[] = [{ dir: rootReal, depth: 0 }]
  let sinceYield = 0

  const addFile = async (path: string, name: string, dir: string): Promise<void> => {
    let st
    try {
      st = await stat(path)
    } catch {
      result.unreadable++
      return
    }
    if (!st.isFile()) return
    const entry: ScanEntry = {
      path,
      relDir: relativeDir(rootReal, dir),
      name,
      size: st.size,
      mtime: Math.floor(st.mtimeMs),
      cloud: false
    }
    if (placeholderSuspicion(st) === 'suspect') suspects.push(entry)
    result.entries.push(entry)
    sinceYield++
  }

  scan: while (stack.length > 0) {
    checkAborted(opts.signal)
    const { dir, depth } = stack.pop()!
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      result.unreadable++
      continue
    }
    for (const d of dirents) {
      const full = join(dir, d.name)
      if (d.isDirectory()) {
        if (isSkippedDirName(d.name)) continue
        if (depth + 1 > opts.maxDepth) {
          result.depthCapped = true
          continue
        }
        const real = caseInsensitive ? full.toLowerCase() : full
        if (visited.has(real)) continue
        visited.add(real)
        stack.push({ dir: full, depth: depth + 1 })
      } else if (d.isSymbolicLink()) {
        // Follow a link only when it stays inside the watched folder and leads somewhere new.
        let target: string
        try {
          target = await realpath(full)
        } catch {
          result.skippedLinks++
          continue
        }
        if (!isInside(rootReal, target, caseInsensitive)) {
          result.skippedLinks++
          continue
        }
        let st
        try {
          st = await stat(target)
        } catch {
          result.skippedLinks++
          continue
        }
        if (st.isDirectory()) {
          const key = caseInsensitive ? target.toLowerCase() : target
          if (isSkippedDirName(d.name) || visited.has(key) || depth + 1 > opts.maxDepth) {
            result.skippedLinks++
            continue
          }
          visited.add(key)
          stack.push({ dir: target, depth: depth + 1 })
        } else if (st.isFile() && isPdfName(d.name)) {
          await addFile(target, d.name, dir)
        }
      } else if (d.isFile()) {
        if (isPdfName(d.name) && !d.name.startsWith('.')) {
          await addFile(full, d.name, dir)
        } else if (platform === 'darwin') {
          const real = icloudStubName(d.name)
          if (real) {
            result.entries.push({ path: join(dir, real), relDir: relativeDir(rootReal, dir), name: real, size: 0, mtime: 0, cloud: true })
          }
        }
      }
      if (result.entries.length >= opts.maxFiles) {
        result.truncated = true
        break scan
      }
      if (sinceYield >= 200) {
        sinceYield = 0
        opts.onProgress?.(result.entries.length, dir)
        await yieldToLoop()
        checkAborted(opts.signal)
      }
    }
  }
  opts.onProgress?.(result.entries.length, rootReal)

  // Placeholder check for the suspects (metadata only; nothing is opened or read).
  if (suspects.length > 0) {
    const attrs = platform === 'win32' && opts.readAttributes ? await opts.readAttributes(suspects.map((s) => s.path)) : new Map<string, number | null>()
    for (const s of suspects) s.cloud = resolveSuspect(platform, attrs.get(s.path) ?? null)
  }

  const notes: string[] = []
  if (result.truncated) notes.push(`Stopped after ${opts.maxFiles.toLocaleString('en-US')} files; the folder has more.`)
  if (result.depthCapped) notes.push(`Folders deeper than ${opts.maxDepth} levels were skipped.`)
  if (result.unreadable > 0) notes.push(`${result.unreadable} item${result.unreadable === 1 ? '' : 's'} could not be read.`)
  if (result.skippedLinks > 0) notes.push(`${result.skippedLinks} link${result.skippedLinks === 1 ? '' : 's'} leading outside the folder (or in a loop) ${result.skippedLinks === 1 ? 'was' : 'were'} skipped.`)
  result.note = notes.join(' ')
  return result
}
