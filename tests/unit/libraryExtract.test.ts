import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { extractText, hashFile, quickHash } from '../../src/main/features/library/extract'
import { TEST_ASSETS } from '../support/libraryEngine'
import { makeCjkPdf, makeCorruptPdf, makeImageOnlyPdf, makeNotPdf, makePasswordPdf, makeTextPdf } from '../support/libraryFixtures'

let dir: string
const write = (name: string, bytes: Uint8Array): string => {
  const p = join(dir, name)
  writeFileSync(p, bytes)
  return p
}
const req = (path: string, knownHash: string | null = null) => ({ path, knownHash, maxPages: 1000, assets: TEST_ASSETS })

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'epdf-libx-'))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('text extraction (pdf.js legacy build in Node)', () => {
  it('extracts the text of every page, with accents', async () => {
    const p = write('text.pdf', await makeTextPdf(['Annual report 2024\nRevenue grew', 'Café résumé naïve über', 'Third page: budget']))
    const r = await extractText(req(p))
    expect(r.kind).toBe('indexed')
    if (r.kind !== 'indexed') return
    expect(r.pages).toBe(3)
    expect(r.texts.map((t) => t.page)).toEqual([1, 2, 3])
    expect(r.texts[0].text).toContain('Annual report 2024')
    expect(r.texts[1].text).toContain('Café résumé naïve über')
    expect(r.words).toBeGreaterThan(10)
  })

  it('extracts CJK text (ToUnicode) and spaces the characters for the tokenizer', async () => {
    const p = write('cjk.pdf', await makeCjkPdf(['日本語のテスト 你好世界']))
    const r = await extractText(req(p))
    expect(r.kind).toBe('indexed')
    if (r.kind !== 'indexed') return
    expect(r.texts[0].text.replace(/ /g, '')).toBe('日本語のテスト你好世界')
    expect(r.texts[0].text).toContain('日 本 語')
  })

  it('marks an image-only (scanned) document as "no text" and says to run OCR', async () => {
    const r = await extractText(req(write('scan.pdf', await makeImageOnlyPdf(3))))
    expect(r.kind).toBe('no_text')
    if (r.kind === 'no_text') {
      expect(r.pages).toBe(3)
      expect(r.note).toMatch(/OCR/)
    }
  })

  it('records a password-protected PDF as not indexable, with the reason, and does not throw', async () => {
    const r = await extractText(req(write('locked.pdf', makePasswordPdf())))
    expect(r.kind).toBe('unindexable')
    if (r.kind === 'unindexable') expect(r.reason).toMatch(/Password-protected/)
  })

  it('records corrupt, non-PDF and empty files as not indexable', async () => {
    const corrupt = await extractText(req(write('corrupt.pdf', makeCorruptPdf())))
    expect(corrupt.kind).toBe('unindexable')
    const notPdf = await extractText(req(write('fake.pdf', makeNotPdf())))
    expect(notPdf).toMatchObject({ kind: 'unindexable' })
    if (notPdf.kind === 'unindexable') expect(notPdf.reason).toMatch(/Not a PDF/)
    const empty = await extractText(req(write('empty.pdf', new Uint8Array(0))))
    expect(empty).toMatchObject({ kind: 'unindexable', reason: 'The file is empty.' })
  })

  it('reports a file that disappeared as missing', async () => {
    expect(await extractText(req(join(dir, 'nope.pdf')))).toEqual({ kind: 'missing' })
  })

  it('skips extraction when the quick hash still matches (only the timestamp moved)', async () => {
    const p = write('same.pdf', await makeTextPdf(['same content']))
    const first = await extractText(req(p))
    if (first.kind !== 'indexed') throw new Error('expected indexed')
    const again = await extractText(req(p, first.hash))
    expect(again).toMatchObject({ kind: 'unchanged', hash: first.hash })
    write('same.pdf', await makeTextPdf(['different content now']))
    expect((await extractText(req(p, first.hash))).kind).toBe('indexed')
  })

  it('limits the number of pages and says so', async () => {
    const p = write('long.pdf', await makeTextPdf(Array.from({ length: 6 }, (_, i) => `page number ${i + 1}`)))
    const r = await extractText({ ...req(p), maxPages: 3 })
    expect(r.kind).toBe('indexed')
    if (r.kind === 'indexed') {
      expect(r.texts).toHaveLength(3)
      expect(r.pages).toBe(6)
      expect(r.note).toMatch(/first 3 of 6/)
    }
  })

  it('quickHash and hashFile agree, and change with the content or size', async () => {
    const big = new Uint8Array(200_000).map((_, i) => i % 251)
    const p = write('big.bin.pdf', big)
    expect((await hashFile(p))!.hash).toBe(quickHash(big))
    const b2 = big.slice()
    b2[b2.length - 1] ^= 1
    expect(quickHash(b2)).not.toBe(quickHash(big))
    expect(quickHash(big.subarray(0, 199_999))).not.toBe(quickHash(big))
  })
})
