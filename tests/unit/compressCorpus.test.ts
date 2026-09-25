import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { PRESETS } from '../../src/renderer/src/features/compress/pdf/options'
import { pdfjsPageCount, pdfjsPageSize, pdfjsText } from './compressPdfjs'
import { createEncryptedFormPdf } from '../fixtures/forms-signing.mjs'

/**
 * The other features ship fixture generators (forms, signing, markup, page tools, text editing): odd structures written by
 * hand or by pdf-lib in different ways. Run the reducer over all of them with every preset and check with pdf-lib AND PDF.js
 * that pages, sizes and text are unchanged.
 */

const dir = mkdtempSync(join(tmpdir(), 'epdf-corpus-'))
let files: string[] = []

beforeAll(() => {
  for (const g of ['generate', 'edit-content', 'forms-signing', 'markup', 'pages-print']) {
    execFileSync(process.execPath, [resolve('tests/fixtures', `${g}.mjs`), dir], { stdio: 'ignore' })
  }
  files = readdirSync(dir).filter((f) => f.endsWith('.pdf') && !['not-a-pdf.pdf', 'encrypted.pdf', 'forms-encrypted.pdf'].includes(f))
}, 120_000)

describe('fixtures from every feature survive every preset', () => {
  it('has a meaningful corpus', () => {
    expect(files.length).toBeGreaterThanOrEqual(12)
  })

  for (const preset of ['high', 'balanced', 'smallest'] as const) {
    it(`${preset}: same pages, sizes and text as the original in pdf-lib and PDF.js`, async () => {
      let reduced = 0
      for (const f of files) {
        const input = new Uint8Array(readFileSync(join(dir, f)))
        let original: PDFDocument
        try {
          original = await PDFDocument.load(input)
        } catch {
          continue // the fixture is deliberately unreadable by pdf-lib
        }
        const r = await compressPdf(input, PRESETS[preset], { codec: pureCodec })
        expect(r.bytes.length, `${f} must not grow`).toBeLessThanOrEqual(input.length)
        if (r.kept === 'original') continue
        reduced++
        const out = await PDFDocument.load(r.bytes)
        expect(out.getPageCount(), `${f} page count`).toBe(original.getPageCount())
        expect(await pdfjsPageCount(r.bytes), `${f} PDF.js page count`).toBe(original.getPageCount())
        const pages = Math.min(original.getPageCount(), 6)
        for (let p = 0; p < pages; p++) {
          expect(out.getPage(p).getSize(), `${f} page ${p + 1} size`).toEqual(original.getPage(p).getSize())
          expect(out.getPage(p).getRotation().angle, `${f} page ${p + 1} rotation`).toBe(original.getPage(p).getRotation().angle)
          expect(await pdfjsText(r.bytes, p + 1), `${f} page ${p + 1} text`).toBe(await pdfjsText(input, p + 1))
        }
        expect(await pdfjsPageSize(r.bytes, 1)).toEqual(await pdfjsPageSize(input, 1))
        // form fields keep their names and values
        const fieldsIn = original.getForm().getFields().map((x) => x.getName())
        expect(out.getForm().getFields().map((x) => x.getName()), `${f} fields`).toEqual(fieldsIn)
      }
      expect(reduced).toBeGreaterThanOrEqual(3)
    }, 240_000)
  }

  it('encrypted documents are refused with a clear message (the app unlocks them first via ensureEditable)', async () => {
    const enc = new Uint8Array(createEncryptedFormPdf() as Uint8Array)
    await expect(compressPdf(enc, PRESETS.balanced, { codec: pureCodec })).rejects.toThrow(/password protected/i)
  })

  it('a truncated file gives a readable error or a valid result, never a crash', async () => {
    const good = new Uint8Array(readFileSync(join(dir, 'heavy.pdf')))
    let refused = 0
    for (const cut of [0.1, 0.5, 0.9]) {
      const bytes = good.subarray(0, Math.floor(good.length * cut))
      try {
        const r = await compressPdf(bytes, PRESETS.balanced, { codec: pureCodec })
        expect(r.bytes.length).toBeLessThanOrEqual(bytes.length)
      } catch (err) {
        refused++
        expect((err as Error).message).toMatch(/could not be read/)
      }
    }
    // Damaged files are refused (and so left exactly as they are) rather than "repaired" into a file that silently lacks parts.
    expect(refused).toBeGreaterThanOrEqual(1)
  })
})
