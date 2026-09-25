import { randomBytes } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PDFName } from 'pdf-lib'
import { afterEach, describe, expect, it } from 'vitest'
import { writeSplitFiles } from '../../src/main/features/pages/files'
import { friendlyPdfError, runSplit } from '../../src/main/features/pages/splitJob'
import { addOutline, fileContains, makeDoc, pageLabelsOf, reload } from './pdfTestUtils'
import { readOutline } from '../../src/shared/features/pages/outline'

const N = (s: string): PDFName => PDFName.of(s)
const noop = (): void => undefined

/** 6 pages of ~120 KB (incompressible padding), page 4 is ~700 KB. */
async function heavyDoc(): Promise<Uint8Array> {
  const doc = await makeDoc(6, { prefix: 'Heavy' })
  const kb = [120, 120, 120, 700, 120, 120]
  doc.getPages().forEach((p, i) => p.node.set(N('EpdfPad'), doc.context.register(doc.context.stream(randomBytes(kb[i] * 1024)))))
  return doc.save()
}

describe('split job (planning + producing real files)', () => {
  it('by size: every part that can fit is under the limit, oversized pages are flagged, and parts only hold their own pages', async () => {
    const bytes = await heavyDoc()
    const limit = 300 * 1024
    const out = await runSplit(bytes, { by: 'size', maxBytes: limit }, noop)
    expect(out.parts.map((p) => p.pages)).toEqual(['1-2', '3', '4', '5-6'])
    expect(out.parts.map((p) => p.oversized)).toEqual([false, false, true, false])
    for (const p of out.parts) if (!p.oversized) expect(p.bytes.length).toBeLessThanOrEqual(limit)
    expect(out.parts[2].bytes.length).toBeGreaterThan(limit)
    expect(out.warnings.join(' ')).toMatch(/Page 4 alone is/)
    // The padding of other pages is not dragged along: parts are (much) smaller than the source.
    expect(out.parts.reduce((s, p) => s + p.bytes.length, 0)).toBeLessThan(bytes.length * 1.05)
    const first = await reload(out.parts[0].bytes)
    expect(pageLabelsOf(first, 'Heavy')).toEqual(['Heavy 1', 'Heavy 2'])
    expect(fileContains(first, 'Heavy 3')).toBe(false)
  })

  it('by ranges and every-N produce the requested files; bad ranges are refused', async () => {
    const bytes = await (await makeDoc(7)).save()
    const r = await runSplit(bytes, { by: 'ranges', ranges: [{ from: 1, to: 3 }, { from: 4, to: 7 }] }, noop)
    const docs = await Promise.all(r.parts.map((p) => reload(p.bytes)))
    expect(docs.map((d) => pageLabelsOf(d))).toEqual([['Page 1', 'Page 2', 'Page 3'], ['Page 4', 'Page 5', 'Page 6', 'Page 7']])
    expect(r.parts.map((p) => p.pages)).toEqual(['1-3', '4-7'])
    const e = await runSplit(bytes, { by: 'every', pages: 3 }, noop)
    expect(e.parts.map((p) => p.pages)).toEqual(['1-3', '4-6', '7'])
    await expect(runSplit(bytes, { by: 'ranges', ranges: [{ from: 5, to: 9 }] }, noop)).rejects.toThrow(/does not fit a document of 7 pages/)
  })

  it('by bookmarks: nested, missing and broken bookmarks; each part keeps the bookmarks that live in it', async () => {
    const doc = await makeDoc(6)
    addOutline(doc, [
      { title: 'One', page: 0, children: [{ title: 'One.a', page: 1 }] },
      { title: 'Two', page: 2 },
      { title: 'Broken', named: 'nowhere' },
      { title: 'Three', page: 4 }
    ])
    const out = await runSplit(await doc.save(), { by: 'bookmarks' }, noop)
    expect(out.parts.map((p) => [p.label, p.pages])).toEqual([['One', '1-2'], ['Two', '3-4'], ['Three', '5-6']])
    expect(out.warnings.join(' ')).toMatch(/skipped/)
    const first = readOutline(await reload(out.parts[0].bytes)).nodes
    expect(first.map((n) => n.title)).toEqual(['One'])
    expect(first[0].children.map((c) => [c.title, c.dest?.pageIndex])).toEqual([['One.a', 1]])
    expect(first[0].dest?.pageIndex).toBe(0)
    const third = readOutline(await reload(out.parts[2].bytes)).nodes
    expect(third.map((n) => [n.title, n.dest?.pageIndex])).toEqual([['Three', 0]])
  })

  it('a document without bookmarks, and unreadable or protected files, give readable errors', async () => {
    const bytes = await (await makeDoc(3)).save()
    await expect(runSplit(bytes, { by: 'bookmarks' }, noop)).rejects.toThrow('This document has no bookmarks.')
    await expect(runSplit(new Uint8Array([1, 2, 3]), { by: 'every', pages: 1 }, noop)).rejects.toThrow(/could not be processed/)
    expect(friendlyPdfError(new Error('Input document to `PDFDocument.load` is encrypted.')).message).toMatch(/password protected/)
  })

  it('reports progress from 0 to 1', async () => {
    const seen: number[] = []
    await runSplit(await (await makeDoc(4)).save(), { by: 'every', pages: 1 }, (f) => seen.push(f))
    expect(seen[0]).toBeLessThan(0.1)
    expect(seen.at(-1)!).toBeGreaterThan(0.5)
    expect([...seen].sort((a, b) => a - b)).toEqual(seen)
  })
})

describe('writeSplitFiles', () => {
  const dirs: string[] = []
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'epdf-split-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })
  const part = (label: string, byte: number): { bytes: Uint8Array; pages: string; label: string; oversized: boolean } => ({ bytes: new Uint8Array([byte]), pages: '1', label, oversized: false })

  it('writes sanitized, numbered files and never overwrites an existing one', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'Book - 01 - Intro.pdf'), 'keep me')
    const written = await writeSplitFiles(dir, 'Book', [part('Intro', 1), part('../../etc/passwd', 2), part('CON', 3), part('a/b\\c:d', 4)], new AbortController().signal)
    expect(written.map((w) => w.name)).toEqual(['Book - 01 - Intro (2).pdf', 'Book - 02 - etc passwd.pdf', 'Book - 03 - _CON.pdf', 'Book - 04 - a b c d.pdf'])
    expect(readFileSync(join(dir, 'Book - 01 - Intro.pdf'), 'utf8')).toBe('keep me')
    expect(readdirSync(dir)).toHaveLength(5)
    for (const w of written) expect(w.path.startsWith(dir)).toBe(true)
  })

  it('removes what it wrote when cancelled part-way, and fails clearly for a missing folder', async () => {
    const dir = tmp()
    const ac = new AbortController()
    const parts = [part('one', 1), part('two', 2)]
    ac.abort()
    await expect(writeSplitFiles(dir, 'X', parts, ac.signal)).rejects.toThrow('Cancelled')
    expect(readdirSync(dir)).toEqual([])
    await expect(writeSplitFiles(join(dir, 'does-not-exist'), 'X', parts, new AbortController().signal)).rejects.toThrow('not available')
  })

  it('file names from a real split stay unique when two bookmarks share a title', async () => {
    const dir = tmp()
    const written = await writeSplitFiles(dir, 'Doc', [part('Same', 1), part('Same', 2)], new AbortController().signal)
    expect(new Set(written.map((w) => w.name.toLowerCase())).size).toBe(2)
  })
})
