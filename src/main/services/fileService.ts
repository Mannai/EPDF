import { createHash } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Repos } from '../db'
import type { VersionInfo } from '../../shared/types'

/**
 * Writes `bytes` to `path` so a crash or full disk never leaves a half-written PDF: data goes to a
 * temp file in the same directory, is flushed to disk, then renamed over the target.
 */
export async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const tmp = `${path}.epdf-${process.pid}-${Date.now()}.tmp`
  const fh = await open(tmp, 'w')
  try {
    await fh.writeFile(bytes)
    await fh.sync()
  } finally {
    await fh.close()
  }
  try {
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

const hashOf = (p: string): string => createHash('sha1').update(p.toLowerCase()).digest('hex').slice(0, 20)

const exists = (p: string): Promise<boolean> => stat(p).then(() => true, () => false)

export class FileService {
  constructor(
    private dataDir: string,
    private repos: Pick<Repos, 'recovery' | 'versions'>
  ) {}

  private recoveryPath = (docPath: string): string => join(this.dataDir, 'recovery', `${hashOf(docPath)}.pdf`)

  /**
   * Saves a document: snapshots the file currently on disk into version history, atomically replaces it,
   * and drops any autosaved recovery copy (the on-disk file is now the source of truth).
   */
  async save(docPath: string, bytes: Uint8Array, note = ''): Promise<{ size: number; mtime: number }> {
    await this.snapshotCurrent(docPath, note).catch((err) => console.warn('version snapshot failed', err))
    await atomicWrite(docPath, bytes)
    await this.clearRecovery(docPath)
    const st = await stat(docPath)
    return { size: st.size, mtime: st.mtimeMs }
  }

  /** Writes bytes to a brand-new location (Save As / Save a Copy). No version snapshot is needed. */
  async writeNew(path: string, bytes: Uint8Array): Promise<{ size: number; mtime: number }> {
    await atomicWrite(path, bytes)
    const st = await stat(path)
    return { size: st.size, mtime: st.mtimeMs }
  }

  private async snapshotCurrent(docPath: string, note: string): Promise<void> {
    if (!(await exists(docPath))) return
    const dir = join(this.dataDir, 'versions', hashOf(docPath))
    await mkdir(dir, { recursive: true })
    const snapshot = join(dir, `${Date.now()}.pdf`)
    await copyFile(docPath, snapshot)
    const size = (await stat(snapshot)).size
    this.repos.versions.add(docPath, snapshot, size, note)
    for (const old of this.repos.versions.prune(docPath)) await rm(old, { force: true })
  }

  listVersions(docPath: string): VersionInfo[] {
    return this.repos.versions.list(docPath).map(({ id, savedAt, size, note }) => ({ id, savedAt, size, note }))
  }

  async readVersion(docPath: string, versionId: number): Promise<Uint8Array | null> {
    const v = this.repos.versions.get(versionId)
    if (!v || v.docPath !== docPath) return null // a docId can only read its own document's history
    return readFile(v.snapshotPath).catch(() => null)
  }

  async writeRecovery(docPath: string, bytes: Uint8Array): Promise<void> {
    const p = this.recoveryPath(docPath)
    await mkdir(dirname(p), { recursive: true })
    await atomicWrite(p, bytes)
    this.repos.recovery.set(docPath, p)
  }

  hasRecovery(docPath: string): boolean {
    return this.repos.recovery.get(docPath) !== null
  }

  async readRecovery(docPath: string): Promise<Uint8Array | null> {
    const r = this.repos.recovery.get(docPath)
    return r ? readFile(r.recoveryPath).catch(() => null) : null
  }

  async clearRecovery(docPath: string): Promise<void> {
    const p = this.repos.recovery.remove(docPath)
    if (p) await rm(p, { force: true })
  }
}
