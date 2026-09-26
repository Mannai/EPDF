import { PDFDocument } from 'pdf-lib'
import { expect, it } from 'vitest'
import { defaultHeaderFooter, defaultWatermark } from '../../src/shared/features/headerfooter'
import { applyGroup } from '../../src/renderer/src/features/headerfooter/pdf/ops'
import { buildPageText } from '../../src/shared/pagetext'
import { findNormalized } from '../../src/shared/text'
import { setupText } from './helpers/text'

setupText()

// Cross-feature check: headers, footers and watermarks are drawn inside /Artifact marked content and Form XObjects;
// the page text model (viewer text layer, search, copy) must still read them in logical order.
it('an Arabic header, Hebrew footer and Arabic/English watermark added by Epdf read back in logical order', async () => {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < 3; i++) pdf.addPage([595, 842])
  const hf = defaultHeaderFooter()
  hf.slots = { topLeft: '', topCenter: 'صفحة {page} من {pages}', topRight: '', bottomLeft: 'עמוד {page} מתוך {pages}', bottomCenter: '', bottomRight: '' }
  hf.numberStyle = 'arabic-indic'
  await applyGroup(pdf, { group: 'headerfooter', settings: hf }, { mode: 'add', fileName: 'x.pdf' })
  const wm = defaultWatermark()
  if (wm.source.kind === 'text') wm.source.text = 'مسودة DRAFT'
  await applyGroup(pdf, { group: 'watermark', settings: wm }, { mode: 'add', fileName: 'x.pdf' })

  const reopened = await PDFDocument.load(await pdf.save())
  const m = buildPageText(reopened, 1)
  const lines = m.lines.map((l) => m.text.slice(l.start, l.end).trim())
  expect(lines).toContain('صفحة ٢ من ٣')
  expect(lines).toContain('עמוד ٢ מתוך ٣')
  expect(lines.some((l) => l.includes('مسودة') && l.includes('DRAFT'))).toBe(true)
  // what the find bar does: tashkeel-insensitive search finds the header word
  expect(findNormalized(m.text, 'صفحه').length + findNormalized(m.text, 'صفحة').length).toBeGreaterThan(0)
})
