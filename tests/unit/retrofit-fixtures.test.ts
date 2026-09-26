import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawText } from '../../src/shared/text'

/**
 * Fixture PDFs for tests/e2e/text-retrofit.spec.ts that need the text engine to be written (the Playwright transform
 * does not load the engine's WebAssembly): two versions of an Arabic document for the comparison report.
 */

export const OLD_LINES = ['تقرير المبيعات السنوي', 'بلغ إجمالي المبيعات 1,250 دينار في الربع الأول', 'שורה בעברית ללא שינוי']
export const NEW_LINES = ['تقرير المبيعات السنوي', 'بلغ إجمالي المبيعات 1,750 دينار في الربع الثاني', 'שורה בעברית ללא שינוי']

async function doc(lines: string[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([595, 842])
  let y = 760
  for (const l of lines) {
    await drawText(page, l, { x: 72, y, size: 14, width: 450, align: 'start' })
    y -= 30
  }
  return pdf.save()
}

describe('fixtures for the text retrofit end-to-end tests', () => {
  it('writes the Arabic comparison pair', async () => {
    const dir = resolve('test-results/fixtures')
    mkdirSync(dir, { recursive: true })
    writeFileSync(resolve(dir, 'rt-cmp-old.pdf'), await doc(OLD_LINES))
    writeFileSync(resolve(dir, 'rt-cmp-new.pdf'), await doc(NEW_LINES))
    expect(OLD_LINES.length).toBe(3)
  })
})
