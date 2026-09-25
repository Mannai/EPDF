import { PDFDocument, StandardFonts } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { analyzePage } from '../../src/renderer/src/features/textedit/pdfcontent/analyze'
import { buildBlocks } from '../../src/renderer/src/features/textedit/pdfcontent/blocks'
import { applyTextEdit } from '../../src/renderer/src/features/textedit/pdfcontent/textEdit'
import { buildPdf, helvetica, notoBytes, pdfLibDoc, subsetSimpleFont } from './helpers/pdfBuilder'

/**
 * Cross-check against PDF.js (legacy build, runs in Node): positions and text our engine reports must match
 * what PDF.js itself extracts from the same file, and edited files must still be readable by it.
 */

interface Item {
  str: string
  transform: number[]
  width: number
  height: number
}

async function pdfjsItems(bytes: Uint8Array, pageNo = 1): Promise<Item[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, isEvalSupported: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    const page = await doc.getPage(pageNo)
    const tc = await page.getTextContent()
    return (tc.items as Array<Item & { str?: string }>).filter((i) => typeof i.str === 'string' && i.str !== '') as Item[]
  } finally {
    await task.destroy()
  }
}

const near = (a: number, b: number, eps: number, msg?: string): void => expect(Math.abs(a - b), msg).toBeLessThan(eps)

describe('geometry agrees with PDF.js', () => {
  it('pdf-lib generated text: origin, width and text of every run', async () => {
    const bytes = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.TimesRoman)
      page.drawText('Times text at 18pt', { x: 100, y: 500, size: 18, font: f })
      page.drawText('Second line, smaller', { x: 100, y: 470, size: 10, font: f })
    })
    const items = await pdfjsItems(bytes)
    const runs = analyzePage(await PDFDocument.load(bytes), 0).runs
    expect(items.map((i) => i.str)).toEqual(runs.map((r) => r.text))
    items.forEach((it, i) => {
      const r = runs[i]
      near(it.transform[4], r.matrix[4], 0.01, `x of ${r.text}`)
      near(it.transform[5], r.matrix[5], 0.01, `y of ${r.text}`)
      near(it.width, r.bbox.x1 - r.bbox.x0, 0.05, `width of ${r.text}`)
    })
  })

  it('scaled, translated and text-matrix positioned runs with TJ kerning', async () => {
    const { bytes } = await buildPdf([
      {
        content: 'q 1.5 0 0 1.5 20 30 cm BT /F1 12 Tf 1 0 0 1 40 100 Tm [(A) -300 (BC) 40 (D)] TJ 0 -20 Td 110 Tz (Wide) Tj ET Q',
        fonts: { F1: helvetica }
      }
    ])
    const items = await pdfjsItems(bytes)
    const runs = analyzePage(await PDFDocument.load(bytes), 0).runs
    expect(runs).toHaveLength(2)
    // PDF.js reports the text-space matrix already multiplied with the CTM
    near(items[0].transform[4], runs[0].matrix[4], 0.01)
    near(items[0].transform[5], runs[0].matrix[5], 0.01)
    near(items[1].transform[4], runs[1].matrix[4], 0.01)
    near(items[1].transform[5], runs[1].matrix[5], 0.01)
    near(items[1].width, runs[1].bbox.x1 - runs[1].bbox.x0, 0.05)
  })

  it('an embedded Unicode subset font (Type0 Identity-H)', async () => {
    const bytes = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(notoBytes(), { subset: true })
      page.drawText('Ünïcödé Привет', { x: 60, y: 300, size: 22, font: f })
    })
    const items = await pdfjsItems(bytes)
    const runs = analyzePage(await PDFDocument.load(bytes), 0).runs
    expect(items.map((i) => i.str).join('')).toBe(runs.map((r) => r.text).join(''))
    near(items[0].transform[4], runs[0].matrix[4], 0.01)
    near(items[0].width, runs[0].bbox.x1 - runs[0].bbox.x0, 0.2)
  })
})

describe('edited files are read back correctly by PDF.js, and the old text is really gone', () => {
  const run = async (bytes: Uint8Array, contains: string, newText: string, extra = {}): Promise<Uint8Array> => {
    const doc = await PDFDocument.load(bytes)
    const set = buildBlocks(analyzePage(doc, 0))
    const b = set.lines.find((l) => l.text.includes(contains))!
    await applyTextEdit(doc, 0, { blockId: b.id, oldText: b.text, newText, ...extra }, { unicodeFont: async () => notoBytes() })
    return doc.save()
  }

  it('in-place edit', async () => {
    const src = await pdfLibDoc(async (doc, page) => {
      const f = await doc.embedFont(StandardFonts.Helvetica)
      page.drawText('The confidential figure is 42', { x: 72, y: 600, size: 16, font: f })
      page.drawText('A second, untouched line', { x: 72, y: 560, size: 16, font: f })
    })
    const out = await run(src, 'confidential', 'The public figure is 43')
    const text = (await pdfjsItems(out)).map((i) => i.str)
    expect(text).toEqual(['The public figure is 43', 'A second, untouched line'])
    expect(text.join(' ')).not.toContain('confidential')
  })

  it('replace with a fallback font (subset font that cannot encode the new characters)', async () => {
    const { doc } = await buildPdf([{ content: 'BT /F1 18 Tf 72 600 Td (Secret) Tj ET BT /F1 18 Tf 72 500 Td (Keep) Tj ET', fonts: {} }])
    const f = subsetSimpleFont(doc, { codes: { 0x53: 'S', 0x65: 'e', 0x63: 'c', 0x72: 'r', 0x74: 't', 0x4b: 'K', 0x70: 'p' } })
    doc.getPage(0).node.Resources()!.set(doc.context.obj('Font') as never, doc.context.obj({ F1: f }))
    const out = await run(await doc.save(), 'Secret', 'Public Ω')
    const items = await pdfjsItems(out)
    expect(items.map((i) => i.str).sort()).toEqual(['Keep', 'Public Ω'])
    // the replacement sits on the original baseline
    const pub = items.find((i) => i.str === 'Public Ω')!
    near(pub.transform[5], 600, 0.01)
    near(pub.transform[4], 72, 0.01)
    expect(new TextDecoder('latin1').decode(out)).not.toContain('(Secret)')
  })
})
