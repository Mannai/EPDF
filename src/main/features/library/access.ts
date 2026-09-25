import { realpath } from 'node:fs/promises'
import { parseRef } from '../../../shared/features/library'
import { isInside } from '../../../shared/features/library/plan'
import { InvalidPdfError, validatePdfFile } from '../../services/docRegistry'
import type { LibraryRepo } from './repo'

/**
 * The gate every open goes through. The renderer only ever names a file by an opaque ref; this resolves it to a
 * path and refuses anything that is not (a) a file the library knows, (b) inside its watched folder after
 * resolving links (a link pointing out of the folder is never followed), or a file the user opened before, and
 * (c) still a real PDF on disk.
 */

export type Target =
  | { ok: true; path: string; name: string; fileId: number | null; cloud: boolean }
  | { ok: false; name: string; reason: string; /** The file is gone: main should drop it from the index. */ gone?: boolean; fileId?: number }

export interface AccessDeps {
  repo: LibraryRepo
  caseInsensitive?: boolean
  /** Test seam; default reads the first bytes of the file and checks the PDF header. */
  validate?: (path: string) => Promise<void>
}

const defaultValidate = async (path: string): Promise<void> => {
  await validatePdfFile(path)
}

export async function resolveTarget(deps: AccessDeps, ref: unknown): Promise<Target> {
  const parsed = parseRef(ref)
  if (!parsed) return { ok: false, name: 'file', reason: 'That is not a valid file reference.' }
  const { repo } = deps
  const validate = deps.validate ?? defaultValidate
  const ci = deps.caseInsensitive ?? (process.platform === 'win32' || process.platform === 'darwin')

  let path: string
  let name: string
  let fileId: number | null = null
  let cloud = false

  if (parsed.kind === 'recent') {
    const r = repo.getRecent(parsed.id)
    if (!r) return { ok: false, name: 'file', reason: 'That file is no longer in your recent files.' }
    path = r.path
    name = r.name
  } else {
    const f = repo.getFile(parsed.id)
    if (!f || f.hidden) return { ok: false, name: f?.name ?? 'file', reason: 'That file is no longer in the library.' }
    path = f.path
    name = f.name
    fileId = f.id
    cloud = f.cloud || f.state === 'cloud'
    if (f.rootId !== null) {
      const root = repo.getRoot(f.rootId)
      if (!root) return { ok: false, name, reason: 'The folder this file belongs to was removed from the library.' }
      let realRoot: string
      try {
        realRoot = await realpath(root.path)
      } catch {
        return { ok: false, name, reason: 'The folder is not available right now (is the drive connected?).' }
      }
      let realFile: string
      try {
        realFile = await realpath(path)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return code === 'ENOENT' || code === 'ENOTDIR'
          ? { ok: false, name, reason: 'The file no longer exists. It was removed from the library.', gone: true, fileId }
          : { ok: false, name, reason: 'The file cannot be read.' }
      }
      if (!isInside(realRoot, realFile, ci)) return { ok: false, name, reason: 'This file is outside the watched folder (a link leads out of it), so it will not be opened.' }
      path = realFile
    } else if (!repo.db.prepare('SELECT 1 FROM recent_files WHERE path = ?').get(path)) {
      return { ok: false, name, reason: 'This file is not in a watched folder.' }
    }
  }

  try {
    await validate(path)
  } catch (err) {
    if (err instanceof InvalidPdfError) {
      const gone = /no longer exists/i.test(err.message)
      return { ok: false, name, reason: gone ? 'The file no longer exists. It was removed from the library.' : err.message, gone, fileId: fileId ?? undefined }
    }
    return { ok: false, name, reason: 'The file cannot be read.' }
  }
  return { ok: true, path, name, fileId, cloud }
}
