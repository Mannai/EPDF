import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { resolveStack } from '../../src/shared/text/fonts'
import { layoutParagraph } from '../../src/shared/text/layout'
import { useNodeResources } from '../../src/shared/text/node'
import { drawParagraph } from '../../src/shared/text/pdf/draw'
import { CORPUS, byId, type CorpusItem } from '../support/textCorpus'

/**
 * Writes the PDFs (and the description of the equivalent HTML) that the Playwright rendering harness
 * (tests/e2e/text-engine.spec.ts) compares against Chromium's own text rendering. The engine is TypeScript that
 * imports WebAssembly loaders, so it is exercised here (vitest) rather than inside the Playwright transform.
 */

export const OUT = resolve('test-results/text')
const fontUrl = (file: string): string => 'file:///' + resolve('resources/fonts', file).replace(/\\/g, '/')

async function make(item: CorpusItem, name: string, override: { direction?: 'ltr' | 'rtl' | 'auto' } = {}): Promise<void> {
  const size = item.size ?? 20
  const opts = { size, fontStack: item.fonts, lang: item.lang, direction: override.direction ?? item.direction, width: item.width, align: item.align }
  const layout = await layoutParagraph(item.text, opts)
  const pdf = await PDFDocument.create()
  const boxW = layout.boxWidth ?? layout.width
  const page = pdf.addPage([Math.ceil(boxW) + 40, Math.ceil(layout.height) + 40])
  await drawParagraph(page, item.text, { ...opts, x: 20, y: page.getHeight() - 20 })
  writeFileSync(resolve(OUT, `${name}.pdf`), await pdf.save())
  const stack = await resolveStack({ fontStack: item.fonts, lang: item.lang })
  // Chromium picks the first covering font of its list per character. The engine additionally prefers the emoji font for
  // emoji-presentation characters, so the reference lists the emoji font before the symbol fonts (still after every text font).
  const files = stack.filter((c) => c.file)
  const emojiAt = files.findIndex((c) => c.category === 'emoji')
  const symbolAt = files.findIndex((c) => c.category === 'symbol')
  if (emojiAt >= 0 && symbolAt >= 0 && emojiAt > symbolAt) files.splice(symbolAt, 0, files.splice(emojiAt, 1)[0]!)
  writeFileSync(
    resolve(OUT, `${name}.json`),
    JSON.stringify({
      fonts: files.map((c) => ({ name: `EF-${c.file}`, url: fontUrl(c.file!) })),
      families: files.map((c) => `EF-${c.file}`),
      sizePt: size,
      lang: item.lang,
      boxWidth: boxW,
      lines: layout.lines.map((l) => ({ text: layout.text.slice(l.textStart, l.textEnd).replace(/ +$/, ''), dir: l.rtl ? 'rtl' : 'ltr', height: l.height }))
    })
  )
}

describe('artifacts for the Chromium comparison harness', () => {
  it('writes one PDF per corpus item plus the negative controls', async () => {
    useNodeResources()
    mkdirSync(OUT, { recursive: true })
    for (const item of CORPUS) await make(item, item.id)
    // Negative control 1: our engine with the wrong paragraph direction on mixed-direction text.
    await make({ ...byId('mixed-rtl') }, 'neg-wrong-direction', { direction: 'ltr' })
    // Negative control 2: different text drawn with our engine.
    await make({ ...byId('ar-plain'), text: 'مرحبا بالعالم، هذا نص مختلف تماما' }, 'neg-different-text')
    // Negative control 3: pdf-lib's drawText (embedded font through fontkit, logical order left to right, no bidi).
    const pdf = await PDFDocument.create()
    pdf.registerFontkit(fontkit)
    const font = await pdf.embedFont(readFileSync('resources/fonts/NotoNaskhArabic-Regular.ttf'), { subset: true })
    const item = byId('ar-plain')
    const layout = await layoutParagraph(item.text, { size: item.size ?? 20, fontStack: item.fonts })
    const page = pdf.addPage([Math.ceil(layout.width) + 40, Math.ceil(layout.height) + 40])
    page.drawText(item.text, { x: 20, y: 30, size: item.size ?? 20, font })
    writeFileSync(resolve(OUT, 'neg-pdf-lib.pdf'), await pdf.save())
    expect(CORPUS.length).toBeGreaterThan(20)
  })
})
