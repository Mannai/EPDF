import Database from 'better-sqlite3'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { RecoveryRepo, VersionsRepo } from '../../src/main/db/repos'
import { FileService, atomicWrite } from '../../src/main/services/fileService'

let dir: string
let svc: FileService
let docPath: string
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s)
const text = (p: string): string => readFileSync(p, 'utf8')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-fs-'))
  const db = new Database(':memory:')
  migrate(db)
  svc = new FileService(join(dir, 'data'), { recovery: new RecoveryRepo(db), versions: new VersionsRepo(db) })
  docPath = join(dir, 'doc.pdf')
  writeFileSync(docPath, 'ORIGINAL')
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('atomicWrite', () => {
  it('replaces the file and leaves no temp files behind', async () => {
    await atomicWrite(docPath, bytes('NEW'))
    expect(text(docPath)).toBe('NEW')
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })
  it('does not touch the target when the write fails', async () => {
    await expect(atomicWrite(join(dir, 'missing-dir', 'x.pdf'), bytes('X'))).rejects.toThrow()
    expect(text(docPath)).toBe('ORIGINAL')
  })
})

describe('FileService.save', () => {
  it('writes the new bytes and keeps the previous file as a version', async () => {
    const r = await svc.save(docPath, bytes('EDITED'))
    expect(text(docPath)).toBe('EDITED')
    expect(r.size).toBe(6)
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
})

describe('recovery files', () => {
  it('round-trips and clears', async () => {
    expect(svc.hasRecovery(docPath)).toBe(false)
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    expect(svc.hasRecovery(docPath)).toBe(true)
    expect(new TextDecoder().decode((await svc.readRecovery(docPath))!)).toBe('AUTOSAVED')
    await svc.writeRecovery(docPath, bytes('AUTOSAVED 2'))
    expect(new TextDecoder().decode((await svc.readRecovery(docPath))!)).toBe('AUTOSAVED 2')
    await svc.clearRecovery(docPath)
    expect(svc.hasRecovery(docPath)).toBe(false)
    expect(await svc.readRecovery(docPath)).toBeNull()
    expect(existsSync(join(dir, 'data', 'recovery')) ? readdirSync(join(dir, 'data', 'recovery')) : []).toEqual([])
  })
  it('the original file is never modified by autosave', async () => {
    await svc.writeRecovery(docPath, bytes('AUTOSAVED'))
    expect(text(docPath)).toBe('ORIGINAL')
  })
})
