import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { openRepos, type Repos } from '../../src/main/db'
import { LibraryRepo } from '../../src/main/features/library/repo'

/** Deleted library text must not linger in the database file or its write-ahead log. */

const MARKER = 'Qzxv7Marker'

let dir: string
let repos: Repos
let repo: LibraryRepo

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-secdel-'))
  repos = openRepos(join(dir, 'epdf.db'))
  repo = new LibraryRepo(repos.db)
})
afterEach(() => {
  repos.db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Does any file of the database (main file, -wal, -shm) contain the marker, in any letter case? */
function leaks(): boolean {
  const needles = [MARKER, MARKER.toLowerCase(), MARKER.toUpperCase()].map((s) => Buffer.from(s))
  for (const suffix of ['', '-wal', '-shm']) {
    const p = join(dir, `epdf.db${suffix}`)
    if (!existsSync(p)) continue
    const bytes = readFileSync(p)
    if (needles.some((n) => bytes.includes(n))) return true
  }
  return false
}

function indexSecret(): number {
  const rootId = repo.addRoot(join(dir, 'docs'), 'Docs', 'folder').id
  const id = repo.insertFile(rootId, { path: join(dir, 'docs', 'a.pdf'), relDir: '', name: 'a.pdf', size: 10, mtime: 1, cloud: false }, 'pending')
  const filler = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ')
  repo.applyIndex(id, { state: 'indexed', note: '', pages: 3, hash: 'h', words: 5, size: 10, mtime: 1, cloud: false, texts: [1, 2, 3].map((page) => ({ page, text: `${filler} the secret ${MARKER} ${filler}` })) })
  const other = repo.insertFile(rootId, { path: join(dir, 'docs', 'b.pdf'), relDir: '', name: 'b.pdf', size: 10, mtime: 1, cloud: false }, 'pending')
  repo.applyIndex(other, { state: 'indexed', note: '', pages: 1, hash: 'h2', words: 5, size: 10, mtime: 1, cloud: false, texts: [{ page: 1, text: `${filler} harmless` }] })
  return id
}

describe('deleting library text', () => {
  it('is on: secure_delete for the database and secure-delete for the full-text index', () => {
    expect(repos.db.pragma('secure_delete', { simple: true })).toBe(1)
    const opt = repos.db.prepare("SELECT v FROM library_text_config WHERE k = 'secure-delete'").get() as { v: number } | undefined
    expect(opt?.v).toBe(1)
  })

  it('Forget everything, then compacting, leaves no trace of the text in epdf.db or epdf.db-wal', () => {
    indexSecret()
    repo.checkpoint()
    expect(leaks()).toBe(true) // the check itself can see the text
    repo.forget()
    repo.compact()
    expect(leaks()).toBe(false)
  })

  it('forgetting one file’s text, then a checkpoint, leaves no trace of it either', () => {
    const id = indexSecret()
    repo.checkpoint()
    expect(leaks()).toBe(true)
    repo.forgetContent(id)
    repo.checkpoint()
    expect(leaks()).toBe(false)
    const hits = repo.search({ query: 'harmless', scope: { kind: 'all' }, offset: 0, limit: 5 })
    expect(hits.ok && hits.total).toBe(1)
  })
})
