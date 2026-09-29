import Database from 'better-sqlite3'
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { RecoveryRepo, VersionsRepo } from '../../src/main/db/repos'
import { DocRegistry } from '../../src/main/services/docRegistry'
import { FileChangedError, FileService, identityOf } from '../../src/main/services/fileService'

/** The open-document registry: change detection on disk, also after our own replace-by-rename saves. */

let dir: string
let doc: string
let changed: string[]
let reg: DocRegistry
let files: FileService
const pdf = (s: string): string => `%PDF-1.7\n${s}\n%%EOF\n`
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await sleep(25)
  }
  return cond()
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-reg-'))
  doc = join(dir, 'doc.pdf')
  writeFileSync(doc, pdf('one'))
  changed = []
  reg = new DocRegistry((id) => changed.push(id), 60)
  const db = new Database(':memory:')
  migrate(db)
  files = new FileService(join(dir, 'data'), { recovery: new RecoveryRepo(db), versions: new VersionsRepo(db) })
})
afterEach(() => {
  reg.disposeAll()
  rmSync(dir, { recursive: true, force: true })
})

/** What the file:save handler does. */
async function save(docId: string, content: string): Promise<void> {
  reg.beginWrite(docId)
  try {
    const r = await files.save(reg.pathOf(docId)!, new TextEncoder().encode(pdf(content)), '', reg.identityOf(docId))
    reg.noteWritten(docId, r.size, r.mtime, r.identity)
  } finally {
    reg.endWrite(docId)
  }
}

describe('DocRegistry change detection', () => {
  it('does not report our own save, and still reports an external change after it', async () => {
    const h = await reg.register(doc)
    await save(h.docId, 'two, saved by Epdf')
    await sleep(400)
    expect(changed).toEqual([])
    // Another program now saves the way most editors do: a new file renamed over the old one.
    const tmp = join(dir, 'other-editor.tmp')
    writeFileSync(tmp, pdf('three, saved by another program'))
    renameSync(tmp, doc)
    expect(await until(() => changed.length > 0)).toBe(true)
    expect(changed[0]).toBe(h.docId)
  })

  it('keeps watching after several saves of ours', async () => {
    const h = await reg.register(doc)
    for (let i = 0; i < 3; i++) await save(h.docId, `save ${i}`)
    await sleep(300)
    expect(changed).toEqual([])
    writeFileSync(doc, pdf('changed in place by someone else'))
    expect(await until(() => changed.length > 0)).toBe(true)
  })

  it('a save after an unnoticed external change is refused; the next one (after the question) goes through', async () => {
    const h = await reg.register(doc)
    reg.disposeAll() // no watcher: the change goes unnoticed, as on a network drive
    const h2 = await reg.register(doc)
    await sleep(20)
    writeFileSync(doc, pdf('theirs, much longer than before'))
    await expect(save(h2.docId, 'mine')).rejects.toBeInstanceOf(FileChangedError)
    await reg.recordDiskState(h2.docId)
    expect(reg.identityOf(h2.docId)).toEqual(identityOf(statSync(doc)))
    await save(h2.docId, 'mine') // "Overwrite"
    expect(h.docId).not.toBe(h2.docId)
  })

  it('opening a file again that changed behind the watcher reports the change', async () => {
    const h = await reg.register(doc)
    await sleep(20)
    writeFileSync(doc, pdf('changed'))
    changed = []
    const again = await reg.register(doc)
    expect(again.docId).toBe(h.docId)
    expect(changed).toContain(h.docId)
  })
})
