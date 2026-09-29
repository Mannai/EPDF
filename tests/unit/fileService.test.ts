import Database from 'better-sqlite3'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { RecoveryRepo, VersionsRepo } from '../../src/main/db/repos'
import {
  FileChangedError,
  FileService,
  ReadOnlyFileError,
  atomicWrite,
  hasExplicitAce,
  identityOf,
  io,
  sweepStaleTemps
} from '../../src/main/services/fileService'
import { icaclsPath } from '../../src/main/services/windowsTools'

let dir: string
let db: Database.Database
let recovery: RecoveryRepo
let versions: VersionsRepo
let svc: FileService
let docPath: string
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (p: string): string => readFileSync(p, 'utf8')
const temps = (d = dir): string[] => readdirSync(d).filter((f) => f.endsWith('.tmp'))
const win = process.platform === 'win32'
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0
const icacls = (...args: string[]): string => execFileSync(icaclsPath(), args, { encoding: 'utf8', windowsHide: true })
const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 20)

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-fs-'))
  db = new Database(':memory:')
  migrate(db)
  recovery = new RecoveryRepo(db)
  versions = new VersionsRepo(db)
  svc = new FileService(join(dir, 'data'), { recovery, versions })
  docPath = join(dir, 'doc.pdf')
  writeFileSync(docPath, 'ORIGINAL')
})
afterEach(() => {
  vi.restoreAllMocks()
  // A test may leave a read-only file behind.
  for (const f of readdirSync(dir, { recursive: true }) as string[]) {
    try {
      chmodSync(join(dir, f), 0o666)
    } catch {
      /* directories, links */
    }
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    await atomicWrite(docPath, bytes('NEW'))
    expect(text(docPath)).toBe('NEW')
    expect(temps()).toEqual([])
  })
  it('does not touch the target when the write fails', async () => {
    await expect(atomicWrite(join(dir, 'missing-dir', 'x.pdf'), bytes('X'))).rejects.toThrow()
    expect(text(docPath)).toBe('ORIGINAL')
  })

  it.each([
    ['the data cannot be written', 'write'],
    ['the flush fails', 'sync'],
    ['the rename fails', 'rename']
  ] as const)('leaves the original and no temp file when %s', async (_label, op) => {
    vi.spyOn(io, op).mockRejectedValueOnce(Object.assign(new Error('injected'), { code: 'EIO' }))
    await expect(atomicWrite(docPath, bytes('NEW'))).rejects.toThrow('injected')
    expect(text(docPath)).toBe('ORIGINAL')
    expect(temps()).toEqual([])
  })

  it('retries a rename that Windows refuses for a moment (a scanner holding the file)', async () => {
    const orig = io.rename
    const spy = vi
      .spyOn(io, 'rename')
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EBUSY' }))
      .mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'EPERM' }))
      .mockImplementation(orig)
    await atomicWrite(docPath, bytes('NEW'), { platform: 'win32', checkSpecial: false })
    expect(text(docPath)).toBe('NEW')
    expect(spy).toHaveBeenCalledTimes(3)
    expect(temps()).toEqual([])
  })

  it('refuses a read-only file with a clear error and changes nothing', async () => {
    chmodSync(docPath, 0o444)
    const err = await atomicWrite(docPath, bytes('NEW')).catch((e: unknown) => e)
    if (isRoot) return // root may write anything
    expect(err).toBeInstanceOf(ReadOnlyFileError)
    expect((err as Error).message).toMatch(/doc\.pdf.*read-only/)
    expect(text(docPath)).toBe('ORIGINAL')
    expect(temps()).toEqual([])
  })

  it('does not overwrite a file that changed since the caller read it', async () => {
    const seen = identityOf(statSync(docPath))
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(docPath, 'CHANGED BY SOMEONE ELSE')
    await expect(atomicWrite(docPath, bytes('NEW'), { expect: seen })).rejects.toBeInstanceOf(FileChangedError)
    expect(text(docPath)).toBe('CHANGED BY SOMEONE ELSE')
    await atomicWrite(docPath, bytes('NEW'), { expect: identityOf(statSync(docPath)) })
    expect(text(docPath)).toBe('NEW')
  })

  it('checks again right before the rename', async () => {
    const seen = identityOf(statSync(docPath))
    const orig = io.sync
    vi.spyOn(io, 'sync').mockImplementationOnce(async (fh) => {
      writeFileSync(docPath, 'CHANGED WHILE SAVING') // another program writes while the temp file is flushed
      return orig(fh)
    })
    await expect(atomicWrite(docPath, bytes('NEW'), { expect: seen, checkSpecial: false })).rejects.toBeInstanceOf(FileChangedError)
    expect(text(docPath)).toBe('CHANGED WHILE SAVING')
    expect(temps()).toEqual([])
  })

  it('writes through a symbolic link to the real file and keeps the link', async () => {
    const link = join(dir, 'link.pdf')
    try {
      symlinkSync(docPath, link)
    } catch {
      return // creating symbolic links needs a privilege on Windows
    }
    await atomicWrite(link, bytes('VIA LINK'))
    expect(text(docPath)).toBe('VIA LINK')
    expect(readdirSync(dir)).toContain('link.pdf')
    expect(statSync(link).ino).toBe(statSync(docPath).ino)
  })

  it('writes in place when the file has another hard link, so both names keep the new content', async () => {
    const other = join(dir, 'other-name.pdf')
    linkSync(docPath, other)
    const ino = statSync(docPath).ino
    await atomicWrite(docPath, bytes('NEW CONTENT'))
    expect(text(docPath)).toBe('NEW CONTENT')
    expect(text(other)).toBe('NEW CONTENT')
    expect(statSync(docPath).nlink).toBe(2)
    expect(statSync(docPath).ino).toBe(ino)
    expect(temps()).toEqual([])
  })

  it('puts the original back when an in-place write fails, and removes its backup', async () => {
    linkSync(docPath, join(dir, 'other-name.pdf'))
    const backups = (): string[] => readdirSync(tmpdir()).filter((f) => f.startsWith('epdf-backup-'))
    const before = backups()
    const orig = io.write
    // 1st write: the backup copy; 2nd: the new content (fails); the restore then writes normally
    vi.spyOn(io, 'write').mockImplementationOnce(orig).mockRejectedValueOnce(new Error('disk full')).mockImplementation(orig)
    await expect(atomicWrite(docPath, bytes('A MUCH LONGER NEW CONTENT'))).rejects.toThrow('disk full')
    expect(text(docPath)).toBe('ORIGINAL')
    expect(text(join(dir, 'other-name.pdf'))).toBe('ORIGINAL')
    expect(backups().filter((b) => !before.includes(b))).toEqual([])
  })

  it('names the backup when even putting the original back fails', async () => {
    linkSync(docPath, join(dir, 'other-name.pdf'))
    const orig = io.write
    vi.spyOn(io, 'write').mockImplementationOnce(orig).mockRejectedValue(new Error('disk gone'))
    const err = (await atomicWrite(docPath, bytes('NEW')).catch((e: unknown) => e)) as Error
    const m = /A copy of the original is at (.+?\.tmp)/.exec(err.message)
    expect(m).not.toBeNull()
    expect(text(m![1])).toBe('ORIGINAL')
    rmSync(m![1])
  })

  it('keeps the permission bits on the rename path (POSIX)', async () => {
    const spy = vi.spyOn(io, 'fchmod')
    const mode = statSync(docPath).mode & 0o7777
    await atomicWrite(docPath, bytes('NEW'), { platform: 'linux' })
    expect(spy).toHaveBeenCalledWith(expect.anything(), mode)
    expect(text(docPath)).toBe('NEW')
  })

  it.runIf(!win)('the new file has the original mode, whatever the umask', async () => {
    chmodSync(docPath, 0o640)
    await atomicWrite(docPath, bytes('NEW'))
    expect(statSync(docPath).mode & 0o777).toBe(0o640)
  })

  it('removes stale temp files of an interrupted save, but not fresh ones or other files', async () => {
    const stale = join(dir, 'doc.pdf.epdf-0123456789abcdef.tmp')
    const legacy = join(dir, 'doc.pdf.epdf-1234-1700000000000.tmp')
    const fresh = join(dir, 'doc.pdf.epdf-fedcba9876543210.tmp')
    const unrelated = join(dir, 'doc.pdf.backup.tmp')
    for (const p of [stale, legacy, fresh, unrelated]) writeFileSync(p, 'x')
    const old = new Date(Date.now() - 10 * 60_000)
    for (const p of [stale, legacy, unrelated]) utimesSync(p, old, old)
    expect(await sweepStaleTemps(docPath)).toBe(2)
    expect(existsSync(stale) || existsSync(legacy)).toBe(false)
    expect(existsSync(fresh) && existsSync(unrelated)).toBe(true)
  })
})

describe('atomicWrite on Windows: permissions and zone marks survive', () => {
  it('reads explicit and inherited entries from icacls output', () => {
    const inherited = 'C:\\x\\a (I).pdf NT AUTHORITY\\SYSTEM:(I)(F)\r\n              BUILTIN\\Users:(I)(RX)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'
    expect(hasExplicitAce(inherited)).toBe(false)
    const own = 'C:\\x\\report (I).pdf BUILTIN\\Users:(R)\r\n              NT AUTHORITY\\SYSTEM:(I)(F)\r\n\r\nSuccessfully processed 1 files; Failed processing 0 files\r\n'
    expect(hasExplicitAce(own)).toBe(true) // "(I)" in the file name does not hide the entry
    expect(hasExplicitAce('C:\\x\\a.pdf DESKTOP\\bob:(DENY)(W,D)\r\n')).toBe(true)
    expect(hasExplicitAce('')).toBe(true)
    expect(hasExplicitAce('Access is denied.\r\n')).toBe(true)
  })

  it.runIf(win)('a private file in a shared folder stays private after a save', async () => {
    const shared = join(dir, 'shared')
    mkdirSync(shared)
    icacls(shared, '/grant', '*S-1-5-32-545:(OI)(CI)(RX)') // Users may read everything in the folder
    const file = join(shared, 'private.pdf')
    writeFileSync(file, 'SECRET')
    icacls(file, '/inheritance:r', '/grant:r', `${userInfo().username}:(F)`) // ...except this file
    const before = icacls(file)
    expect(before).not.toMatch(/\(I\)/)
    await atomicWrite(file, bytes('SECRET v2'))
    expect(text(file)).toBe('SECRET v2')
    expect(icacls(file)).toBe(before)
    expect(temps(shared)).toEqual([])
  })

  it.runIf(win)('an explicit extra entry is kept', async () => {
    icacls(docPath, '/grant', '*S-1-5-32-545:(R)')
    const before = icacls(docPath)
    await atomicWrite(docPath, bytes('NEW'))
    expect(icacls(docPath)).toBe(before)
  })

  it.runIf(win)('the Zone.Identifier stream ("downloaded from the internet") is kept', async () => {
    writeFileSync(`${docPath}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n')
    await atomicWrite(docPath, bytes('NEW'))
    expect(text(docPath)).toBe('NEW')
    expect(text(`${docPath}:Zone.Identifier`)).toContain('ZoneId=3')
  })

  it.runIf(win)('a plain file (inherited permissions only) is replaced by rename', async () => {
    const ino = statSync(docPath).ino
    await atomicWrite(docPath, bytes('NEW'))
    expect(statSync(docPath).ino).not.toBe(ino)
  })

  it.runIf(win)('when icacls cannot answer, the file is written in place', async () => {
    vi.spyOn(io, 'icacls').mockRejectedValueOnce(new Error('not found'))
    const ino = statSync(docPath).ino
    await atomicWrite(docPath, bytes('NEW'))
    expect(statSync(docPath).ino).toBe(ino)
    expect(text(docPath)).toBe('NEW')
  })

  it.runIf(win)('recovery copies skip the permission check', async () => {
    const spy = vi.spyOn(io, 'icacls')
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    await svc.writeRecovery(docPath, bytes('AUTOSAVED 2'))
    expect(spy).not.toHaveBeenCalled()
  })
})

describe('FileService.save', () => {
  it('writes the new bytes and keeps the previous file as a version', async () => {
    const r = await svc.save(docPath, bytes('EDITED'))
    expect(text(docPath)).toBe('EDITED')
    expect(r.size).toBe(6)
    expect(r.identity).toEqual(identityOf(statSync(docPath)))
    const versions = svc.listVersions(docPath)
    expect(versions).toHaveLength(1)
    expect(new TextDecoder().decode((await svc.readVersion(docPath, versions[0].id))!)).toBe('ORIGINAL')
  })

  it('accumulates versions across saves, newest first', async () => {
    await svc.save(docPath, bytes('v2'))
    await new Promise((r) => setTimeout(r, 5))
    await svc.save(docPath, bytes('v3'))
    const versions = svc.listVersions(docPath)
    expect(versions).toHaveLength(2)
    const newest = new TextDecoder().decode((await svc.readVersion(docPath, versions[0].id))!)
    const oldest = new TextDecoder().decode((await svc.readVersion(docPath, versions[1].id))!)
    expect([newest, oldest]).toEqual(['v2', 'ORIGINAL'])
  })

  it('keeps at most 20 versions and deletes the pruned snapshot files', async () => {
    for (let i = 0; i < 23; i++) {
      await svc.save(docPath, bytes(`v${i}`))
      await new Promise((r) => setTimeout(r, 2))
    }
    expect(svc.listVersions(docPath)).toHaveLength(20)
    const files = readdirSync(join(dir, 'data', 'versions'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    expect(files).toHaveLength(20)
  })

  it('two saves in the same millisecond get two snapshots', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    await svc.save(docPath, bytes('v2'))
    await svc.save(docPath, bytes('v3'))
    vi.restoreAllMocks()
    const texts = await Promise.all(svc.listVersions(docPath).map(async (v) => new TextDecoder().decode((await svc.readVersion(docPath, v.id))!)))
    expect(texts.sort()).toEqual(['ORIGINAL', 'v2'])
  })

  it('cannot read another document’s versions', async () => {
    await svc.save(docPath, bytes('x'))
    const id = svc.listVersions(docPath)[0].id
    expect(await svc.readVersion(join(dir, 'other.pdf'), id)).toBeNull()
  })

  it('saving a brand-new path creates no version and clears recovery', async () => {
    const fresh = join(dir, 'fresh.pdf')
    await svc.writeRecovery(fresh, bytes('unsaved'))
    await svc.save(fresh, bytes('first'))
    expect(text(fresh)).toBe('first')
    expect(svc.listVersions(fresh)).toHaveLength(0)
    expect(svc.hasRecovery(fresh)).toBe(false)
  })

  it('a changed file is neither overwritten nor snapshotted', async () => {
    const seen = identityOf(statSync(docPath))
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(docPath, 'THEIRS')
    await expect(svc.save(docPath, bytes('MINE'), '', seen)).rejects.toBeInstanceOf(FileChangedError)
    expect(text(docPath)).toBe('THEIRS')
    expect(svc.listVersions(docPath)).toHaveLength(0)
  })

  it.skipIf(isRoot)('a read-only file is refused before a version is taken', async () => {
    chmodSync(docPath, 0o444)
    await expect(svc.save(docPath, bytes('MINE'))).rejects.toBeInstanceOf(ReadOnlyFileError)
    expect(svc.listVersions(docPath)).toHaveLength(0)
  })

  it('a snapshot that cannot be deleted keeps its record (and is retried by the next prune)', async () => {
    await svc.save(docPath, bytes('v2'))
    const [v] = versions.list(docPath)
    // A directory in place of the snapshot file: deleting it fails.
    rmSync(v.snapshotPath)
    mkdirSync(v.snapshotPath)
    writeFileSync(join(v.snapshotPath, 'x'), 'x')
    expect(await svc.pruneVersions(docPath, 0)).toEqual({ deleted: 0, failed: 1 })
    expect(versions.list(docPath)).toHaveLength(1)
    rmSync(v.snapshotPath, { recursive: true })
    expect(await svc.pruneVersions(docPath, 0)).toEqual({ deleted: 1, failed: 0 })
    expect(versions.list(docPath)).toHaveLength(0)
  })
})

describe('recovery files', () => {
  it('round-trips and clears', async () => {
    expect(svc.hasRecovery(docPath)).toBe(false)
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    expect(svc.hasRecovery(docPath)).toBe(true)
    expect(new TextDecoder().decode((await svc.readRecovery(docPath))!)).toBe('AUTOSAVED')
    await svc.writeRecovery(docPath, bytes('AUTOSAVED 2'))
    expect(new TextDecoder().decode((await svc.readRecovery(docPath))!)).toBe('AUTOSAVED 2')
    expect(await svc.clearRecovery(docPath)).toBe(true)
    expect(svc.hasRecovery(docPath)).toBe(false)
    expect(await svc.readRecovery(docPath)).toBeNull()
    expect(existsSync(join(dir, 'data', 'recovery')) ? readdirSync(join(dir, 'data', 'recovery')) : []).toEqual([])
  })
  it('the original file is never modified by autosave', async () => {
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    expect(text(docPath)).toBe('ORIGINAL')
  })

  it('documents whose paths differ only in case keep separate copies where the file system tells them apart', async () => {
    const posix = new FileService(join(dir, 'data'), { recovery, versions }, 'linux')
    const a = join(dir, 'Report.pdf')
    const b = join(dir, 'report.pdf')
    await posix.writeRecovery(a, bytes('EDITS OF Report'))
    await posix.writeRecovery(b, bytes('EDITS OF report'))
    expect(new TextDecoder().decode((await posix.readRecovery(a))!)).toBe('EDITS OF Report')
    expect(new TextDecoder().decode((await posix.readRecovery(b))!)).toBe('EDITS OF report')
    expect(recovery.get(a)!.recoveryPath).not.toBe(recovery.get(b)!.recoveryPath)
  })

  it('renames copies from older versions; a copy two documents shared goes to the newest record', async () => {
    const posix = new FileService(join(dir, 'data'), { recovery, versions }, 'linux')
    const recDir = join(dir, 'data', 'recovery')
    mkdirSync(recDir, { recursive: true })
    const a = join(dir, 'Report.pdf')
    const b = join(dir, 'report.pdf')
    const legacy = join(recDir, `${sha1(a.toLowerCase())}.pdf`)
    writeFileSync(legacy, 'LAST AUTOSAVE (of b)')
    recovery.set(a, legacy, 100)
    recovery.set(b, legacy, 200)
    await posix.migrateRecoveryNames()
    expect(recovery.get(a)).toBeNull()
    const moved = recovery.get(b)!
    expect(moved.recoveryPath).not.toBe(legacy)
    expect(moved.savedAt).toBe(200)
    expect(text(moved.recoveryPath)).toBe('LAST AUTOSAVE (of b)')
    expect(existsSync(legacy)).toBe(false)
    await posix.migrateRecoveryNames() // once only
    expect(recovery.get(b)!.recoveryPath).toBe(moved.recoveryPath)
  })

  it('a superseded copy is deleted when the next autosave lands under the new name', async () => {
    const recDir = join(dir, 'data', 'recovery')
    mkdirSync(recDir, { recursive: true })
    const old = join(recDir, 'old-name.pdf')
    writeFileSync(old, 'OLD')
    recovery.set(docPath, old, 1)
    await svc.writeRecovery(docPath, bytes('NEW'))
    expect(existsSync(old)).toBe(false)
    expect(new TextDecoder().decode((await svc.readRecovery(docPath))!)).toBe('NEW')
  })

  it('a copy that cannot be deleted keeps its record', async () => {
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    const p = recovery.get(docPath)!.recoveryPath
    rmSync(p)
    mkdirSync(p)
    writeFileSync(join(p, 'x'), 'x')
    expect(await svc.clearRecovery(docPath)).toBe(false)
    expect(svc.hasRecovery(docPath)).toBe(true)
  })
})

describe('orphaned history files', () => {
  it('deletes files no record points to, once they are a minute old', async () => {
    await svc.save(docPath, bytes('v2'))
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    const vdir = join(dir, 'data', 'versions', 'stray')
    mkdirSync(vdir, { recursive: true })
    const strayVersion = join(vdir, '1.pdf')
    const strayRecovery = join(dir, 'data', 'recovery', 'stray.pdf')
    const young = join(dir, 'data', 'recovery', 'young.pdf')
    for (const p of [strayVersion, strayRecovery, young]) writeFileSync(p, 'LEFT BEHIND')
    const old = new Date(Date.now() - 5 * 60_000)
    utimesSync(strayVersion, old, old)
    utimesSync(strayRecovery, old, old)
    // Known files stay even when old.
    const known = [versions.list(docPath)[0].snapshotPath, recovery.get(docPath)!.recoveryPath]
    for (const k of known) utimesSync(k, old, old)
    expect(await svc.sweepOrphans()).toBe(2)
    expect(existsSync(strayVersion) || existsSync(strayRecovery)).toBe(false)
    expect(existsSync(vdir)).toBe(false)
    expect(existsSync(young)).toBe(true)
    for (const k of known) expect(existsSync(k)).toBe(true)
  })
})

describe('purging a document’s history', () => {
  it('matches the path ignoring case on Windows only', async () => {
    const w = new FileService(join(dir, 'data'), { recovery, versions }, 'win32')
    await w.save(docPath, bytes('v2'))
    const upper = docPath.toUpperCase()
    versions.add(upper, versions.list(docPath)[0].snapshotPath.replace(/\.pdf$/, '-b.pdf'), 1)
    writeFileSync(versions.list(upper)[0].snapshotPath, 'OLD')
    await w.writeRecovery(upper, bytes('AUTOSAVED'))
    expect(w.historyInfo(docPath)).toEqual({ versions: 2, recovery: true })
    const posix = new FileService(join(dir, 'data'), { recovery, versions }, 'linux')
    expect(posix.historyInfo(docPath)).toEqual({ versions: 1, recovery: false })
    expect(await w.purgeHistory(docPath)).toEqual({ versions: 2, deleted: 2, failed: 0, recovery: true })
    expect(versions.docPaths()).toEqual([])
    expect(recovery.all()).toEqual([])
  })
})
