import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib'
import { beforeAll, describe, expect, it } from 'vitest'
import { defaultBackground, defaultHeaderFooter, defaultWatermark } from '../../src/shared/features/headerfooter'
import { applyGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { seePages } from './helpers/hfPdfjs'
import { setupText } from './helpers/text'

/**
 * Sample documents for looking at the result with other renderers (Windows' own PDF engine, a browser, Acrobat): an
 * Arabic header with Hebrew and English footers, a translucent rotated text watermark, a picture in front and a
 * background, on an upright page and on a /Rotate 90 page. Written to test-results/headerfooter/.
 */
setupText()

const OUT = resolve('test-results/headerfooter')

async function sample(rotate: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  const p = pdf.addPage([612, 792])
  p.drawText('Body text: the quick brown fox jumps over the lazy dog.', { x: 72, y: 600, size: 14, font })
  p.drawRectangle({ x: 72, y: 250, width: 468, height: 200, color: rgb(0.85, 0.9, 1) })
  if (rotate) p.setRotation(degrees(rotate))
  pdf.addPage([612, 792])
  pdf.addPage([612, 792])
  const hf = defaultHeaderFooter()
  hf.slots = { topLeft: '', topCenter: 'صفحة {page} من {pages}', topRight: '', bottomLeft: 'עמוד {page} מתוך {pages}', bottomCenter: '', bottomRight: 'Printed {date}' }
  hf.numberStyle = 'arabic-indic'
  hf.font = { family: 'Noto Naskh Arabic', size: 16, color: '#000000', bold: false, italic: false }
  hf.date = { format: 'd mmmm yyyy', digits: 'latin', months: 'en' }
  await applyGroup(pdf, { group: 'headerfooter', settings: hf }, { mode: 'add', fileName: 'sample.pdf', now: new Date(2026, 8, 26) })
  const wm = defaultWatermark()
  if (wm.source.kind === 'text') wm.source.text = 'مسودة DRAFT'
  await applyGroup(pdf, { group: 'watermark', settings: wm }, { mode: 'add', fileName: 'sample.pdf' })
  await applyGroup(pdf, { group: 'background', settings: { ...defaultBackground(), source: { kind: 'color', color: '#fff6d8' } } }, { mode: 'add', fileName: 'sample.pdf' })
  const logo = { ...defaultWatermark(), source: { kind: 'image' as const, name: 'logo.png' }, rotation: 0, opacity: 1, scale: { mode: 'absolute' as const, percent: 50 }, position: { h: 'right' as const, v: 'bottom' as const, dx: -72, dy: 72 } }
  const png = readFileSync(resolve('test-results/fixtures/hf-logo.png'))
  await applyGroup(pdf, { group: 'watermark', settings: logo }, { mode: 'add', fileName: 'sample.pdf', source: { bytes: new Uint8Array(png), kind: 'png' } })
  return pdf.save()
}

describe('sample documents for other renderers', () => {
  beforeAll(() => {
    execFileSync(process.execPath, ['tests/fixtures/headerfooter.mjs', resolve('test-results/fixtures')], { stdio: 'ignore' })
  })
  it('writes winpdf-sample.pdf (upright) and winpdf-sample-rot90.pdf', async () => {
    mkdirSync(OUT, { recursive: true })
    for (const [name, rot] of [
      ['winpdf-sample', 0],
      ['winpdf-sample-rot90', 90]
    ] as const) {
      const bytes = await sample(rot)
      writeFileSync(resolve(OUT, `${name}.pdf`), bytes)
      const seen = await seePages(bytes)
      expect(seen[0]!.text).toContain('صفحة ١ من ٣')
    }
  })
})
