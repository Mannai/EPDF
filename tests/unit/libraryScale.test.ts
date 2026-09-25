import Database from 'better-sqlite3'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { migrate } from '../../src/main/db/migrations'
import { LibraryRepo } from '../../src/main/features/library/repo'
import { prepareIndexText } from '../../src/shared/features/library/text'
import { rng } from '../support/libraryFixtures'

/**
 * Scale check of the SQL side: thousands of files with millions of words, on a real database file. The size defaults
 * to 3,000 files (a few seconds); set EPDF_SCALE_FILES=10000 for the 10k-file measurement quoted in the docs.
 */
const FILES = Number(process.env['EPDF_SCALE_FILES'] ?? 3000)
const PAGES = 4
const WORDS_PER_PAGE = 120
const dir = mkdtempSync(join(tmpdir(), 'epdf-scale-'))
let opened: Database.Database | null = null
afterAll(() => {
  opened?.close() // Windows cannot delete an open database file
  rmSync(dir, { recursive: true, force: true })
})

// A vocabulary with a Zipf-like distribution, so common and rare terms both exist.
const VOCAB = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}${i % 7 === 0 ? 'é' : ''}`)

describe(`library scale (${FILES.toLocaleString('en-US')} files x ${PAGES} pages x ${WORDS_PER_PAGE} words)`, () => {
  const file = join(dir, 'scale.db')
  const db = new Database(file)
  opened = db
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  migrate(db)
  const repo = new LibraryRepo(db)
  const root = repo.addRoot('/scale', 'Scale', 'folder').id
  const timings: Record<string, number> = {}
  const time = <T>(label: string, fn: () => T): T => {
    const t = performance.now()
    const r = fn()
    timings[label] = Math.round((performance.now() - t) * 10) / 10
    return r
  }

  it('indexes and stays queryable', () => {
    const rand = rng(7)
    const word = (): string => VOCAB[Math.floor(Math.pow(rand(), 2.2) * VOCAB.length)]
    time('insert', () => {
      // One transaction per 50 files, like a long sync would commit progressively.
      for (let start = 0; start < FILES; start += 50) {
        db.transaction(() => {
          for (let i = start; i < Math.min(FILES, start + 50); i++) {
            const name = `document-${String(i).padStart(6, '0')}.pdf`
            const id = repo.insertFile(root, { path: `/scale/d${i % 100}/${name}`, relDir: `d${i % 100}`, name, size: 1000 + i, mtime: 1_700_000_000_000 + i, cloud: false }, 'pending')
            const texts = Array.from({ length: PAGES }, (_, p) => {
              const words = Array.from({ length: WORDS_PER_PAGE }, word)
              if (p === 0) words.unshift(`marker${i}`)
              return { page: p + 1, text: prepareIndexText(words.join(' ')) }
            })
            repo.applyIndex(id, { state: 'indexed', note: '', pages: PAGES, hash: `h${i}`, words: WORDS_PER_PAGE * PAGES, size: 1000 + i, mtime: 1_700_000_000_000 + i, cloud: false, texts })
          }
        })()
      }
    })
    expect(repo.counts().all).toBe(FILES)
    const words = repo.counts().words
    expect(words).toBe(FILES * PAGES * WORDS_PER_PAGE)
    timings['dbMB'] = Math.round((statSync(file).size / 1024 / 1024) * 10) / 10

    const search = (q: string, limit = 50, offset = 0) => {
      const r = repo.search({ query: q, scope: { kind: 'all' }, offset, limit })
      if (!r.ok) throw new Error(r.error)
      return r
    }
    const rare = time('search unique marker', () => search(`marker${Math.floor(FILES / 2)}`))
    expect(rare.total).toBe(1)
    const common = time('search common word (50 hits)', () => search(VOCAB[0]))
    expect(common.hits.length).toBe(50)
    time('search common word, page 20', () => search(VOCAB[0], 50, 1000))
    time('search two words AND', () => search(`${VOCAB[1]} ${VOCAB[2]}`))
    time('search phrase', () => search(`"${VOCAB[0]} ${VOCAB[1]}"`))
    time('search prefix', () => search('w1*'))
    time('search NOT', () => search(`${VOCAB[3]} -${VOCAB[0]}`))
    time('search accented', () => search('w0e'))
    time('name search', () => repo.list({ scope: { kind: 'all' }, name: `document-${String(FILES - 1).padStart(6, '0')}`, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 50 }))
    time('list all by name, first page', () => repo.list({ scope: { kind: 'all' }, sort: 'name', descending: false, filter: 'all', offset: 0, limit: 100 }))
    time('list all by size desc, page 20', () => repo.list({ scope: { kind: 'all' }, sort: 'size', descending: true, filter: 'all', offset: 2000, limit: 100 }))
    time('counts', () => repo.counts())
    time('replace one file (re-index)', () => repo.applyIndex(1, { state: 'indexed', note: '', pages: 1, hash: 'x', words: 3, size: 1, mtime: 1, cloud: false, texts: [{ page: 1, text: 'fresh words' }] }))
    time('delete one file', () => repo.deleteFiles([2]))
    console.log(`LIBRARY-SCALE files=${FILES} words=${words.toLocaleString('en-US')}`, JSON.stringify(timings))

    // Generous bounds: this is a smoke test for accidental full scans, not a benchmark.
    for (const k of ['search unique marker', 'search common word (50 hits)', 'search two words AND', 'search phrase', 'search prefix', 'name search', 'list all by name, first page']) {
      expect(timings[k], k).toBeLessThan(1500)
    }
  }, 600_000)
})
