import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { access, lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, rm, rmdir, stat, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Repos } from '../db'
import type { VersionInfo } from '../../shared/types'
import { icaclsPath } from './windowsTools'

/**
 * Writing documents back to disk.
 *
 * A save normally writes a temp file next to the document, flushes it and renames it over the original, so a crash or
 * a full disk never leaves a half-written PDF. A rename, however, replaces the file's identity: its hard links, its
 * own permissions and its alternate data streams belong to the old file and are lost. So Epdf writes **in place**
 * (after a private backup copy, with a verified read-back) whenever the file has something the rename would lose and
 * that can be detected without native code:
 *
 * * more than one hard link (every platform);
 * * on Windows, an access control entry of its own (not inherited from the folder), read with `icacls`;
 * * on Windows, a `Zone.Identifier` stream (the "downloaded from the internet" mark). Other alternate data streams
 *   cannot be listed without native code and are not detected.
 *
 * On the rename path the permission bits and (where the process may) the owner are copied to the new file. POSIX
 * extended attributes and ACLs are not copied, so they are lost on the rename path.
 */

export class ReadOnlyFileError extends Error {
  constructor(path: string) {
    super(`“${basename(path)}” is read-only, so Epdf did not change it. Save a copy with Save As…, or allow changes to the file and save again.`)
    this.name = 'ReadOnlyFileError'
  }
}

export class FileChangedError extends Error {
  constructor(path: string) {
    super(`“${basename(path)}” was changed by another program since Epdf last read it, so it was not overwritten. Save again to choose whether to overwrite it.`)
    this.name = 'FileChangedError'
  }
}

/** Enough of a file's metadata to notice that it was changed or replaced by someone else. */
export interface FileIdentity {
  size: number
  mtimeMs: number
  ino: number
  dev: number
}

export const identityOf = (st: Stats): FileIdentity => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, dev: st.dev })

export const sameIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev

export interface AtomicWriteOptions {
  /** The file as the caller last saw it. If it is different now, nothing is written and `FileChangedError` is thrown. */
  expect?: FileIdentity | null
  /**
   * Look for a file's own Windows permissions and its Zone.Identifier stream (default true). Epdf's own files (the
   * recovery copies written every few seconds) skip this: they never have either.
   */
  checkSpecial?: boolean
  /** Test hook: behave as on this platform. */
  platform?: NodeJS.Platform
}

/** File operations with an indirection, so tests can inject failures. */
export const io = {
  open: (path: string, flags: string, mode?: number): Promise<FileHandle> => open(path, flags, mode),
  write: async (fh: FileHandle, bytes: Uint8Array, position: number): Promise<void> => {
    let off = 0
    while (off < bytes.length) {
      const { bytesWritten } = await fh.write(bytes, off, bytes.length - off, position + off)
      if (bytesWritten <= 0) throw new Error('The disk accepted no more data.')
      off += bytesWritten
    }
  },
  sync: (fh: FileHandle): Promise<void> => fh.sync(),
  fchmod: (fh: FileHandle, mode: number): Promise<void> => fh.chmod(mode),
  fchown: (fh: FileHandle, uid: number, gid: number): Promise<void> => fh.chown(uid, gid),
  rename: (from: string, to: string): Promise<void> => rename(from, to),
  icacls: (path: string): Promise<string> =>
    new Promise((res, rej) =>
      execFile(icaclsPath(), [path], { windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024 }, (err, stdout) => (err ? rej(err) : res(String(stdout))))
    )
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const errCode = (e: unknown): string | undefined => (e as NodeJS.ErrnoException | null)?.code

/** Follows symbolic links to the file that is really written. A path that does not exist yet is returned as is. */
async function resolveTarget(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err
  }
  // A dangling link: write the file it points to (creating it), never replace the link itself.
  let p = path
  for (let i = 0; i < 20; i++) {
    const l = await lstat(p).catch(() => null)
    if (!l?.isSymbolicLink()) return p
    p = resolve(dirname(p), await readlink(p))
  }
  return p
}

/**
 * Does replacing this file by rename lose something detectable? Hard links anywhere; on Windows also an explicit
 * (not inherited) access control entry or a Zone.Identifier stream. When icacls cannot answer, assume yes.
 */
async function needsInPlace(path: string, st: Stats, platform: NodeJS.Platform, checkSpecial: boolean): Promise<boolean> {
  if (st.nlink > 1) return true
  if (platform !== 'win32' || !checkSpecial) return false
  if (await stat(`${path}:Zone.Identifier`).then(() => true, () => false)) return true
  try {
    return hasExplicitAce(await io.icacls(path))
  } catch {
    return true
  }
}

/**
 * In icacls output (`<path> <account>:(I)(F)`, then one `<account>:(flags)` per line) every access control entry
 * inherited from the folder carries `(I)`; one without it is the file's own. Only the flag groups at the end of a line
 * are looked at, so a file name containing "(I)" cannot hide an entry. Output that cannot be read counts as special.
 */
export function hasExplicitAce(icaclsOutput: string): boolean {
  const lines = icaclsOutput.split(/\r?\n/).filter((l) => /\S:\(/.test(l))
  if (lines.length === 0) return true
  return lines.some((l) => {
    const m = /\S:((?:\([A-Za-z,]+\))+)\s*$/.exec(l)
    return !m || !/\(I\)/.test(m[1])
  })
}

async function assertUnchanged(path: string, expect: FileIdentity | null | undefined): Promise<void> {
  if (!expect) return
  const st = await stat(path).catch(() => null)
  if (st && !sameIdentity(identityOf(st), expect)) throw new FileChangedError(path)
}

async function assertWritable(path: string, st: Stats, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') {
    if ((st.mode & 0o200) === 0) throw new ReadOnlyFileError(path)
    return
  }
  try {
    await access(path, constants.W_OK)
  } catch {
    throw new ReadOnlyFileError(path)
  }
}

/**
 * The checks a save makes before anything is touched: the file is still what the caller saw and may be written.
 * Returns the stat of the resolved file (null when it does not exist yet).
 */
export async function checkBeforeWrite(path: string, opts: Pick<AtomicWriteOptions, 'expect' | 'platform'> = {}): Promise<Stats | null> {
  const target = await resolveTarget(path)
  const st = await stat(target).catch((e) => (errCode(e) === 'ENOENT' ? null : Promise.reject(e)))
  if (!st) return null
  if (!st.isFile()) throw new Error(`“${basename(path)}” is not a regular file.`)
  if (opts.expect && !sameIdentity(identityOf(st), opts.expect)) throw new FileChangedError(path)
  await assertWritable(target, st, opts.platform ?? process.platform)
  return st
}

/**
 * Writes `bytes` to `path` without ever leaving a half-written file: by rename from a flushed temp file, or in place
 * after a backup when a rename would lose the file's links, permissions or zone mark (see the top of this file).
 * On any failure the temp file is removed and the original is unchanged.
 */
export async function atomicWrite(path: string, bytes: Uint8Array, opts: AtomicWriteOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform
  const target = await resolveTarget(path)
  const st = await checkBeforeWrite(target, opts)
  if (st && (await needsInPlace(target, st, platform, opts.checkSpecial !== false))) {
    await writeInPlace(target, bytes, opts.expect)
    return
  }
  const done = await writeViaRename(target, bytes, st, platform, opts.expect)
  if (!done) await writeInPlace(target, bytes, opts.expect) // the owner could not be kept on a new file
}

/** `<name>.epdf-<16 hex>.tmp`, next to the document. */
const TEMP_RE = /\.epdf-(?:[0-9a-f]{16}|\d+-\d+)\.tmp$/

async function writeViaRename(target: string, bytes: Uint8Array, st: Stats | null, platform: NodeJS.Platform, expect: FileIdentity | null | undefined): Promise<boolean> {
  const dir = dirname(target)
  const tmp = join(dir, `${basename(target)}.epdf-${randomBytes(8).toString('hex')}.tmp`)
  const mode = st ? st.mode & 0o7777 : 0o666
  let fh: FileHandle | null = null
  let renamed = false
  try {
    fh = await io.open(tmp, 'wx', mode)
    await io.write(fh, bytes, 0)
    if (st && platform !== 'win32') {
      await io.fchmod(fh, mode) // the mode passed to open() is reduced by the umask
      const mine = await fh.stat()
      if (mine.uid !== st.uid || mine.gid !== st.gid) {
        try {
          await io.fchown(fh, st.uid, st.gid)
        } catch {
          return false // not allowed to give the new file the original owner: write in place instead
        }
      }
    }
    await io.sync(fh)
    await fh.close()
    fh = null
    await assertUnchanged(target, expect)
    await renameWithRetry(tmp, target, platform)
    renamed = true
  } finally {
    if (fh) await fh.close().catch(() => undefined)
    if (!renamed) await rm(tmp, { force: true }).catch(() => undefined)
  }
  if (platform !== 'win32') await syncDir(dir)
  return true
}

async function renameWithRetry(from: string, to: string, platform: NodeJS.Platform): Promise<void> {
  // Windows: a virus scanner or the search indexer briefly holding the file makes the rename fail with EBUSY/EPERM.
  const delays = platform === 'win32' ? [30, 80, 150, 300, 600] : []
  for (let i = 0; ; i++) {
    try {
      await io.rename(from, to)
      return
    } catch (err) {
      const c = errCode(err)
      if (i >= delays.length || (c !== 'EBUSY' && c !== 'EPERM' && c !== 'EACCES')) throw err
      await sleep(delays[i])
    }
  }
}

async function syncDir(dir: string): Promise<void> {
  // Makes the rename itself durable. Some file systems refuse to fsync a directory; that is not an error here.
  let fh: FileHandle | null = null
  try {
    fh = await open(dir, 'r')
    await fh.sync()
  } catch {
    /* best effort */
  } finally {
    await fh?.close().catch(() => undefined)
  }
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

async function copyInto(from: string, to: FileHandle): Promise<void> {
  const src = await open(from, 'r')
  try {
    const buf = Buffer.alloc(1024 * 1024)
    let pos = 0
    for (;;) {
      const { bytesRead } = await src.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      await io.write(to, buf.subarray(0, bytesRead), pos)
      pos += bytesRead
    }
  } finally {
    await src.close()
  }
}

async function overwrite(target: string, bytes: Uint8Array): Promise<void> {
  const fh = await io.open(target, 'r+')
  try {
    await io.write(fh, bytes, 0)
    await fh.truncate(bytes.length)
    await io.sync(fh)
  } finally {
    await fh.close()
  }
}

/**
 * Rewrites the file's content through the existing file (same links, permissions, streams). A private backup
 * (0600, in the temp folder) is taken first and the result is read back; on any failure the backup is written back.
 * If even that fails, the error names the backup so nothing is lost.
 */
async function writeInPlace(target: string, bytes: Uint8Array, expect: FileIdentity | null | undefined): Promise<void> {
  const backup = join(tmpdir(), `epdf-backup-${randomBytes(8).toString('hex')}.tmp`)
  const bfh = await open(backup, 'wx', 0o600)
  try {
    await copyInto(target, bfh)
    await bfh.sync()
  } catch (err) {
    await bfh.close().catch(() => undefined)
    await rm(backup, { force: true }).catch(() => undefined)
    throw err
  }
  await bfh.close()
  let keepBackup = false
  try {
    await assertUnchanged(target, expect)
    try {
      await overwrite(target, bytes)
      const written = await readFile(target)
      if (written.length !== bytes.length || sha256(written) !== sha256(bytes)) throw new Error('The file read back differently from what was written.')
    } catch (err) {
      try {
        await overwrite(target, await readFile(backup))
      } catch {
        keepBackup = true
        throw new Error(`Saving “${basename(target)}” failed and the original could not be put back. A copy of the original is at ${backup}. (${(err as Error).message})`)
      }
      throw err
    }
  } finally {
    if (!keepBackup) await rm(backup, { force: true }).catch(() => undefined)
  }
}

/** Removes temp files an interrupted save left next to `path` (older than five minutes, so a running save is safe). */
export async function sweepStaleTemps(path: string, now = Date.now()): Promise<number> {
  const dir = dirname(path)
  const prefix = `${basename(path)}.epdf-`
  let removed = 0
  const names = await readdir(dir).catch(() => [] as string[])
  for (const name of names) {
    if (!name.startsWith(prefix) || !TEMP_RE.test(name)) continue
    const p = join(dir, name)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile() || now - st.mtimeMs < 5 * 60_000) continue
    if (await rm(p, { force: true }).then(() => true, () => false)) removed++
  }
  return removed
}

// ---- Epdf's own copies: version history and recovery ------------------------------------------------------------------

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20)
/** Before 1.1: the path was lowercased on every platform, so two documents differing only in case shared a name. */
const legacyHashOf = (p: string): string => sha1(p.toLowerCase())

async function canonical(p: string): Promise<string> {
  return realpath(p).catch(() => p)
}

/** Deletes a file (missing is fine); retries briefly on Windows, where a scanner may hold it for a moment. */
async function removeFile(p: string): Promise<void> {
  const delays = process.platform === 'win32' ? [50, 150, 400] : []
  for (let i = 0; ; i++) {
    try {
      await rm(p, { force: true })
      return
    } catch (err) {
      if (i >= delays.length) throw err
      await sleep(delays[i])
    }
  }
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    /* not empty, or already gone */
  }
}

export interface HistoryPurge {
  /** Version-history snapshots that existed / were deleted / could not be deleted. */
  versions: number
  deleted: number
  failed: number
  /** An autosaved recovery copy was removed. */
  recovery: boolean
}

export class FileService {
  constructor(
    private dataDir: string,
    private repos: Pick<Repos, 'recovery' | 'versions'>,
    private platform: NodeJS.Platform = process.platform
  ) {}

  /** A document's key for Epdf's own file names: its real path, case-folded only where the file system ignores case. */
  private hashOf(realPath: string): string {
    return sha1(this.platform === 'win32' ? realPath.toLowerCase() : realPath)
  }

  private async recoveryPath(docPath: string): Promise<string> {
    return join(this.dataDir, 'recovery', `${this.hashOf(await canonical(docPath))}.pdf`)
  }

  private samePath(a: string, b: string): boolean {
    return this.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  }

  /**
   * Saves a document: snapshots the file currently on disk into version history, replaces it (see `atomicWrite`),
   * and drops any autosaved recovery copy (the on-disk file is now the source of truth). `expect` is the file as the
   * document last saw it; a different file on disk is not overwritten (`FileChangedError`).
   */
  async save(docPath: string, bytes: Uint8Array, note = '', expect?: FileIdentity | null): Promise<{ size: number; mtime: number; identity: FileIdentity }> {
    await checkBeforeWrite(docPath, { expect, platform: this.platform })
    await this.snapshotCurrent(docPath, note).catch((err) => console.warn('version snapshot failed', err))
    await atomicWrite(docPath, bytes, { expect, platform: this.platform })
    if (!(await this.clearRecovery(docPath))) console.warn('the recovery copy could not be deleted')
    const st = await stat(docPath)
    return { size: st.size, mtime: st.mtimeMs, identity: identityOf(st) }
  }

  /** Writes bytes to a brand-new location (Save As / Save a Copy). No version snapshot is needed. */
  async writeNew(path: string, bytes: Uint8Array): Promise<{ size: number; mtime: number; identity: FileIdentity }> {
    await atomicWrite(path, bytes, { platform: this.platform })
    const st = await stat(path)
    return { size: st.size, mtime: st.mtimeMs, identity: identityOf(st) }
  }

  private async snapshotCurrent(docPath: string, note: string): Promise<void> {
    const st = await stat(docPath).catch(() => null)
    if (!st) return
    const dir = join(this.dataDir, 'versions', this.hashOf(await canonical(docPath)))
    await mkdir(dir, { recursive: true })
    const snapshot = join(dir, `${Date.now()}-${randomBytes(4).toString('hex')}.pdf`)
    const fh = await open(snapshot, 'wx', 0o600)
    try {
      await copyInto(docPath, fh)
      await fh.sync()
    } catch (err) {
      await fh.close().catch(() => undefined)
      await rm(snapshot, { force: true }).catch(() => undefined)
      throw err
    }
    await fh.close()
    const size = (await stat(snapshot)).size
    this.repos.versions.add(docPath, snapshot, size, note)
    await this.pruneVersions(docPath)
  }

  /**
   * Keeps the newest `keep` versions of a document. Each snapshot file is deleted first and its record dropped only
   * once the file is gone, so a file that cannot be deleted stays listed (and is retried) instead of being forgotten.
   */
  async pruneVersions(docPath: string, keep?: number): Promise<{ deleted: number; failed: number }> {
    let deleted = 0
    let failed = 0
    const dirs = new Set<string>()
    for (const v of this.repos.versions.beyond(docPath, keep)) {
      try {
        await removeFile(v.snapshotPath)
        this.repos.versions.remove(v.id)
        dirs.add(dirname(v.snapshotPath))
        deleted++
      } catch (err) {
        console.warn('could not delete a version snapshot', err)
        failed++
      }
    }
    if (keep === 0) for (const d of dirs) await removeIfEmpty(d)
    return { deleted, failed }
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
    const p = await this.recoveryPath(docPath)
    await mkdir(dirname(p), { recursive: true })
    await atomicWrite(p, bytes, { checkSpecial: false, platform: this.platform })
    const previous = this.repos.recovery.get(docPath)
    this.repos.recovery.set(docPath, p)
    // The copy moved (an older name, or the document's real path changed): delete the superseded file.
    if (previous && previous.recoveryPath !== p && this.repos.recovery.usersOf(previous.recoveryPath).length === 0) {
      await removeFile(previous.recoveryPath).catch((err) => console.warn('could not delete an old recovery copy', err))
    }
  }

  hasRecovery(docPath: string): boolean {
    return this.repos.recovery.get(docPath) !== null
  }

  async readRecovery(docPath: string): Promise<Uint8Array | null> {
    const r = this.repos.recovery.get(docPath)
    return r ? readFile(r.recoveryPath).catch(() => null) : null
  }

  /**
   * Deletes the document's recovery copy, then its record. Returns false (keeping the record, so the copy is not
   * forgotten) when the file could not be deleted.
   */
  async clearRecovery(docPath: string): Promise<boolean> {
    const r = this.repos.recovery.get(docPath)
    if (!r) return true
    const shared = this.repos.recovery.usersOf(r.recoveryPath).some((u) => u.docPath !== docPath)
    if (!shared) {
      try {
        await removeFile(r.recoveryPath)
      } catch (err) {
        console.warn('could not delete a recovery copy', err)
        return false
      }
    }
    this.repos.recovery.remove(docPath)
    return true
  }

  /** The document's history under every spelling of its path that names the same file (case, on Windows). */
  private historyPaths(docPath: string): { versions: string[]; recovery: string[] } {
    return {
      versions: this.repos.versions.docPaths().filter((p) => this.samePath(p, docPath)),
      recovery: this.repos.recovery.all().map((r) => r.docPath).filter((p) => this.samePath(p, docPath))
    }
  }

  historyInfo(docPath: string): { versions: number; recovery: boolean } {
    const h = this.historyPaths(docPath)
    return { versions: h.versions.reduce((n, p) => n + this.repos.versions.list(p).length, 0), recovery: h.recovery.length > 0 }
  }

  /** Deletes every version snapshot and the recovery copy of a document. Records of files that could not be deleted stay. */
  async purgeHistory(docPath: string): Promise<HistoryPurge> {
    const h = this.historyPaths(docPath)
    const out: HistoryPurge = { versions: 0, deleted: 0, failed: 0, recovery: false }
    for (const p of h.versions) {
      out.versions += this.repos.versions.list(p).length
      const r = await this.pruneVersions(p, 0)
      out.deleted += r.deleted
      out.failed += r.failed
    }
    for (const p of h.recovery) {
      if (await this.clearRecovery(p)) out.recovery = true
      else out.failed++
    }
    return out
  }

  /**
   * One-time rename of recovery copies named by the old, always-lowercased key. Where several documents shared one
   * old file (paths differing only in case), it holds the newest autosave, so it goes to the newest record and the
   * other records are dropped.
   */
  async migrateRecoveryNames(): Promise<void> {
    const handled = new Set<string>()
    for (const row of this.repos.recovery.all()) {
      if (handled.has(row.recoveryPath)) continue
      handled.add(row.recoveryPath)
      if (basename(row.recoveryPath) !== `${legacyHashOf(row.docPath)}.pdf`) continue
      const users = this.repos.recovery.usersOf(row.recoveryPath).sort((a, b) => b.savedAt - a.savedAt)
      const owner = users[0]
      const next = await this.recoveryPath(owner.docPath)
      try {
        if (next !== row.recoveryPath) {
          await mkdir(dirname(next), { recursive: true })
          await rename(row.recoveryPath, next)
        }
        this.repos.recovery.set(owner.docPath, next, owner.savedAt)
        for (const u of users.slice(1)) this.repos.recovery.remove(u.docPath)
      } catch (err) {
        if (errCode(err) === 'ENOENT') for (const u of users) this.repos.recovery.remove(u.docPath)
        else console.warn('could not rename a recovery copy', err)
      }
    }
  }

  /**
   * Deletes files in `versions/` and `recovery/` that no record points to (left by a crash, or by older versions
   * that dropped the record before the file). Files younger than a minute are left alone: a save may be writing them.
   */
  async sweepOrphans(now = Date.now()): Promise<number> {
    const key = (p: string): string => (this.platform === 'win32' ? p.toLowerCase() : p)
    const known = new Set([...this.repos.versions.allSnapshotPaths(), ...this.repos.recovery.all().map((r) => r.recoveryPath)].map((p) => key(resolve(p))))
    let removed = 0
    const visit = async (dir: string, depth: number): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (depth > 0) {
            await visit(p, depth - 1)
            await removeIfEmpty(p)
          }
          continue
        }
        if (known.has(key(resolve(p)))) continue
        const st = await stat(p).catch(() => null)
        if (!st || now - st.mtimeMs < 60_000) continue
        if (await rm(p, { force: true }).then(() => true, () => false)) removed++
      }
    }
    await visit(join(this.dataDir, 'versions'), 1)
    await visit(join(this.dataDir, 'recovery'), 0)
    return removed
  }
}
