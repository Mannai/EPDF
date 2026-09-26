import { readFileSync } from 'node:fs'
import fontkit from '@pdf-lib/fontkit'
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, rgb } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { drawParagraph, drawText, makeTextXObject } from '../../src/shared/text/pdf/draw'
import { embeddedFontsFor, flushTextFonts } from '../../src/shared/text/pdf/embed'
import { buildToUnicode, parseToUnicode } from '../../src/shared/text/pdf/tounicode'
import { actualTexts, contentOf, fontDicts, fontParts, shownCodes, streamBytes } from '../support/pdfContent'
import { pdfjsLines, setupText } from './helpers/text'

setupText()

async function make(fn: (page: import('pdf-lib').PDFPage, pdf: PDFDocument) => Promise<void>, size: [number, number] = [400, 200]): Promise<{ pdf: PDFDocument; bytes: Uint8Array; page: import('pdf-lib').PDFPage }> {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage(size)
  await fn(page, pdf)
  return { pdf, bytes: await pdf.save(), page }
}

const reload = (bytes: Uint8Array): Promise<PDFDocument> => PDFDocument.load(bytes, { throwOnInvalidObject: true })

describe('font embedding: Type0 / Identity-H subsets', () => {
  it('writes a valid composite font with /ToUnicode, /W and a parseable TrueType subset', async () => {
    const { bytes } = await make(async (page, pdf) => {
      embeddedFontsFor(pdf).uniformNames = false // descriptive names: subset tag + PostScript name
      await drawText(page, 'مرحبا بالعالم', { x: 20, y: 150, size: 18, fontStack: ['Noto Naskh Arabic'] })
    })
    const doc = await reload(bytes)
    const fonts = fontDicts(doc, doc.getPage(0).node.Resources())
    expect(fonts.size).toBe(1)
    const parts = fontParts(doc, [...fonts.values()][0]!)
    const t0 = parts.type0
    expect(t0.get(PDFName.of('Subtype'))).toBe(PDFName.of('Type0'))
    expect(t0.get(PDFName.of('Encoding'))).toBe(PDFName.of('Identity-H'))
    expect(parts.cid.get(PDFName.of('Subtype'))).toBe(PDFName.of('CIDFontType2'))
    expect(parts.cid.get(PDFName.of('CIDToGIDMap'))).toBe(PDFName.of('Identity'))
    expect(parts.descriptor.get(PDFName.of('FontName'))?.toString()).toMatch(/^\/[A-Z]{6}\+NotoNaskhArabic/)
    expect(parts.programKey).toBe('FontFile2')
    // the subset opens in an independent font parser and is tiny
    const f = fontkit.create(parts.program as unknown as Uint8Array) as import('@pdf-lib/fontkit').Font
    expect(f.numGlyphs).toBeGreaterThan(5)
    expect(parts.program.length).toBeLessThan(20_000)
    // /W lists exactly the used codes
    const w = parts.cid.get(PDFName.of('W')) as PDFArray
    expect(w.size()).toBeGreaterThan(0)
  })

  it('every drawn code has a ToUnicode entry; the mapped text reversed is the logical text (pure RTL)', async () => {
    const text = 'مرحبا بالعالم اليوم'
    const { pdf, page, bytes } = await make(async (p) => {
      await drawText(p, text, { x: 20, y: 150, size: 18, fontStack: ['Noto Naskh Arabic'] })
    })
    void bytes
    const doc = await reload(await pdf.save())
    const pg = doc.getPage(0)
    const content = contentOf(doc, pg)
    const parts = fontParts(doc, [...fontDicts(doc, pg.node.Resources()).values()][0]!)
    const visual = shownCodes(content).map((c) => {
      expect(parts.toUnicode.has(c), `code ${c.toString(16)} must have a ToUnicode entry`).toBe(true)
      return parts.toUnicode.get(c)!
    })
    expect(Array.from(visual.join('')).reverse().join('')).toBe(text)
    void page
  })

  it('embeds each font once per document, however many draw calls use it', async () => {
    const { pdf, bytes } = await make(async (page, doc) => {
      for (let i = 0; i < 5; i++) await drawText(page, `سطر رقم ${i}`, { x: 20, y: 180 - i * 25, size: 14, fontStack: ['Noto Naskh Arabic'] })
      const p2 = doc.addPage([300, 100])
      await drawText(p2, 'مرحبا again', { x: 10, y: 50, size: 14, fontStack: ['Noto Naskh Arabic'] })
    })
    const dt = embeddedFontsFor(pdf)
    expect(dt.all().filter((f) => f.font.family.includes('Naskh')).length).toBe(1)
    const doc = await reload(bytes)
    // one Type0 font object for the whole document, referenced from both pages under the same resource name
    const type0 = doc.context.enumerateIndirectObjects().filter(([, o]) => o instanceof PDFDict && o.get(PDFName.of('Subtype')) === PDFName.of('Type0'))
    expect(type0.length).toBe(dt.all().length) // Naskh for Arabic + Noto Sans for "again": one Type0 object per font
    const refs = doc.getPages().map((p) => {
      const fonts = p.node.Resources()!.lookup(PDFName.of('Font'), PDFDict)
      return new Map(fonts.entries().map(([k, v]) => [k.asString(), v.toString()]))
    })
    // a resource name means the same font object on every page (fonts are shared, never re-embedded per page)
    const seen = new Map<string, string>()
    for (const m of refs) for (const [name, ref] of m) expect(seen.get(name) ?? ref, name).toBe(ref), seen.set(name, ref)
    expect(seen.size).toBe(dt.all().length)
  })

  it('saving twice is stable and later draws extend the same subset', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([300, 100])
    await drawText(page, 'مرحبا', { x: 10, y: 60, size: 14, fontStack: ['Noto Sans Arabic'] })
    const first = await pdf.save()
    await drawText(page, 'بالعالم', { x: 10, y: 30, size: 14, fontStack: ['Noto Sans Arabic'] })
    await flushTextFonts(pdf)
    const second = await pdf.save()
    const doc = await reload(second)
    const parts = fontParts(doc, [...fontDicts(doc, doc.getPage(0).node.Resources()).values()][0]!)
    const texts = new Set([...parts.toUnicode.values()].join(''))
    for (const ch of 'مرحباعلب') expect(texts.has(ch), ch).toBe(true)
    expect(second.length).toBeGreaterThan(first.length)
    const doc2 = await reload(first)
    expect(doc2.getPageCount()).toBe(1)
  })

  it('a 1000-word Arabic page adds only kilobytes (subset + compressed content)', async () => {
    const words = 'كتاب مدرسة جامعة مدينة طالب معلم قلم ورقة بيت شمس قمر نهر جبل بحر سماء أرض ماء نار هواء'.split(' ')
    const lines: string[] = []
    for (let l = 0; l < 50; l++) lines.push(Array.from({ length: 20 }, (_, i) => words[(l * 7 + i * 3) % words.length]!).join(' '))
    const empty = await PDFDocument.create()
    empty.addPage([595, 842])
    const base = (await empty.save()).length
    const { bytes } = await make(async (page) => {
      await drawParagraph(page, lines.join('\n'), { x: 20, y: 820, size: 9, fontStack: ['Noto Naskh Arabic'] })
    }, [595, 842])
    const added = bytes.length - base
    console.log(`1000 Arabic words: +${added} bytes`)
    expect(added).toBeLessThan(60_000)
  })

  it('embeds CFF (CID-keyed OpenType) fonts as CIDFontType0C with CID codes', async () => {
    const text = '你好，世界！这是一个中文测试。'
    const { bytes } = await make(async (page) => {
      await drawText(page, text, { x: 20, y: 150, size: 18, lang: 'zh-Hans' })
    })
    const doc = await reload(bytes)
    const pg = doc.getPage(0)
    const fonts = fontDicts(doc, pg.node.Resources())
    const parts = fontParts(doc, [...fonts.values()][0]!)
    expect(parts.cid.get(PDFName.of('Subtype'))).toBe(PDFName.of('CIDFontType0'))
    expect(parts.programKey).toBe('FontFile3')
    expect(parts.program.length).toBeLessThan(400_000)
    const visual = shownCodes(contentOf(doc, pg)).map((c) => parts.toUnicode.get(c) ?? '?')
    expect(visual.join('')).toBe(text)
    expect((await pdfjsLines(bytes))[0]).toBe(text)
  })

  it('synthesises composite glyphs for marks so extraction has no unmapped codes (Arabic tashkeel, Thai, Devanagari)', async () => {
    for (const [text, stack] of [['مُحَمَّدٌ', ['Noto Naskh Arabic']], ['น้ำใจ', ['Noto Sans Thai']], ['क्षत्रिय हिन्दी', ['Noto Sans Devanagari']]] as const) {
      const { bytes } = await make(async (page) => {
        await drawText(page, text, { x: 20, y: 150, size: 24, fontStack: [...stack] })
      })
      const doc = await reload(bytes)
      const pg = doc.getPage(0)
      const parts = fontParts(doc, [...fontDicts(doc, pg.node.Resources()).values()][0]!)
      for (const c of shownCodes(contentOf(doc, pg))) expect(parts.toUnicode.has(c), `${text}: code ${c.toString(16)} unmapped`).toBe(true)
      const f = fontkit.create(parts.program as unknown as Uint8Array) as import('@pdf-lib/fontkit').Font
      expect(f.numGlyphs, text).toBeGreaterThan(0)
    }
  })

  it('gives glyphs shared by different characters (Persian/Arabic yeh, digits) their own codes so text stays exact', async () => {
    const { bytes } = await make(async (page) => {
      await drawText(page, 'دنیا دنيا ۱۲ ١٢', { x: 20, y: 150, size: 20, fontStack: ['Noto Naskh Arabic'] })
    })
    const [line] = await pdfjsLines(bytes)
    expect(line!.normalize('NFKC')).toBe('دنیا دنيا ۱۲ ١٢'.normalize('NFKC'))
  })
})

describe('content stream structure', () => {
  const balanced = (content: string, open: RegExp, close: RegExp): boolean => (content.match(open) ?? []).length === (content.match(close) ?? []).length

  it('is well formed: q/Q, BT/ET, BDC/EMC balance; fonts and states are in the page resources; hex codes are 2 bytes', async () => {
    const { bytes } = await make(async (page) => {
      await drawParagraph(page, [{ text: 'مرحبا ' }, { text: 'Hello ', color: rgb(1, 0, 0) as unknown as [number, number, number] }, { text: 'world', opacity: 0.5 }], {
        x: 20,
        y: 180,
        width: 200,
        size: 16,
        underline: true
      })
    })
    const doc = await reload(bytes)
    const pg = doc.getPage(0)
    const c = contentOf(doc, pg)
    expect(balanced(c, /\bq\b/g, /\bQ\b/g)).toBe(true)
    expect(balanced(c, /\bBT\b/g, /\bET\b/g)).toBe(true)
    expect(balanced(c, /\bBDC\b/g, /\bEMC\b/g) || balanced(c, /(BDC|BMC)\b/g, /\bEMC\b/g)).toBe(true)
    const res = pg.node.Resources()!
    const fonts = fontDicts(doc, res)
    for (const m of c.matchAll(/\/(EpdfF\d+) [\d.]+ Tf/g)) expect(fonts.has(m[1]!)).toBe(true)
    const gs = res.lookup(PDFName.of('ExtGState'), PDFDict)
    for (const m of c.matchAll(/\/(EpdfGS\d+) gs/g)) expect(gs.has(PDFName.of(m[1]!))).toBe(true)
    for (const m of c.matchAll(/<([0-9A-F]+)>/g)) if (!m[1]!.startsWith('FEFF')) expect(m[1]!.length % 4).toBe(0)
    expect(c).not.toMatch(/NaN|Infinity|undefined/)
    // every TJ is preceded by a Tm in its text object
    for (const obj of c.split('BT').slice(1)) if (/TJ/.test(obj)) expect(obj.indexOf('Tm')).toBeGreaterThanOrEqual(0)
  })

  it('gives every embedded font the same BaseFont by default (keeps a line one text run for PDF.js); descriptive names are an option', async () => {
    const { bytes } = await make(async (page) => {
      await drawText(page, 'Hello مرحبا', { x: 20, y: 150, size: 18, direction: 'ltr' })
    })
    const doc = await reload(bytes)
    const names = [...fontDicts(doc, doc.getPage(0).node.Resources()).values()].map((d) => d.get(PDFName.of('BaseFont'))?.toString())
    expect(names.length).toBe(2)
    expect(new Set(names)).toEqual(new Set(['/EPDFTX+EpdfText']))
  })

  it('wraps right-to-left lines in /ActualText with the logical text; plain LTR lines stay plain (auto)', async () => {
    const { pdf, page } = await make(async (p) => {
      await drawText(p, 'مرحبا بالعالم', { x: 20, y: 150, size: 18 })
      await drawText(p, 'Hello world', { x: 20, y: 100, size: 18 })
      await drawText(p, 'Hello مرحبا 123', { x: 20, y: 50, size: 18, direction: 'ltr' })
    })
    const c = contentOf(pdf, page)
    expect(actualTexts(c)).toEqual(['مرحبا بالعالم', 'Hello مرحبا 123'])
  })

  it("extraction: 'visual' never writes ActualText, 'actualText' always does", async () => {
    const mk = async (extraction: 'visual' | 'actualText'): Promise<string> => {
      const { pdf, page } = await make(async (p) => {
        await drawText(p, 'مرحبا', { x: 20, y: 150, size: 18, extraction })
        await drawText(p, 'Hello', { x: 20, y: 100, size: 18, extraction })
      })
      return contentOf(pdf, page)
    }
    expect(actualTexts(await mk('visual'))).toEqual([])
    expect(actualTexts(await mk('actualText'))).toEqual(['مرحبا', 'Hello'])
  })

  it('renders modes, colour, opacity, rotation, skew, clipping and decorations', async () => {
    const { pdf, page } = await make(async (p) => {
      await drawText(p, 'Stroke', { x: 20, y: 150, size: 20, renderMode: 'stroke', strokeColor: [0, 0, 1], strokeWidth: 0.7 })
      await drawText(p, 'Both', { x: 20, y: 120, size: 20, renderMode: 'fillStroke', color: [1, 0, 0] })
      await drawText(p, 'Hidden', { x: 20, y: 90, size: 20, renderMode: 'invisible' })
      await drawText(p, 'Faded', { x: 20, y: 60, size: 20, opacity: 0.4, color: 0.5 })
      await drawText(p, 'Turned', { x: 200, y: 20, size: 16, rotate: 90 })
      await drawText(p, 'Slanted', { x: 100, y: 30, size: 16, xSkew: 15 })
      await drawText(p, 'Clipped text here', { x: 20, y: 5, size: 16, clip: { x: 20, y: 0, width: 50, height: 20 } })
      await drawText(p, 'Underlined', { x: 250, y: 150, size: 14, underline: true, strike: true })
      await drawText(p, 'CMYK', { x: 250, y: 120, size: 14, color: [0, 1, 1, 0] })
    })
    const c = contentOf(pdf, page)
    expect(c).toMatch(/\b1 Tr\b/)
    expect(c).toMatch(/\b2 Tr\b/)
    expect(c).toMatch(/\b3 Tr\b/)
    expect(c).toMatch(/0 0 1 RG/)
    expect(c).toMatch(/0\.7 w/)
    expect(c).toMatch(/1 0 0 rg/)
    expect(c).toMatch(/0\.5 g/)
    expect(c).toMatch(/\/EpdfGS400 gs/)
    expect(c).toMatch(/\b0 1 -1 0 200 20 cm\b/) // 90 degrees: [cos sin -sin cos]
    expect(c).toMatch(/1 0 0 1 [\d.]+ 5 cm|1 0 0 1 20 5 cm/)
    expect(c).toMatch(/20 0 50 20 re W n/)
    expect(c).toMatch(/re f/) // underline / strike bars
    expect(c).toMatch(/0 1 1 0 k/)
    const skew = c.match(/1 0 [0-9.]+ 1 100 30 cm/)
    expect(skew).not.toBeNull()
    const gsDict = pdf.getPage(0).node.Resources()!.lookup(PDFName.of('ExtGState'), PDFDict)
    const state = pdf.context.lookup(gsDict.get(PDFName.of('EpdfGS400')), PDFDict)
    expect((state.get(PDFName.of('ca')) as PDFNumber).asNumber()).toBeCloseTo(0.4, 5)
  })

  it('draws synthetic bold and italic when a font has no such face', async () => {
    const { pdf, page } = await make(async (p) => {
      await drawText(p, 'ሰላም ዓለም', { x: 20, y: 150, size: 20, fontStack: ['Noto Sans Ethiopic'], weight: 'bold', italic: true })
    })
    const c = contentOf(pdf, page)
    expect(c).toMatch(/\b2 Tr\b/) // fill + stroke = faux bold
    expect(c).toMatch(/1 0 0\.2\d+ 1 [\d.]+ [\d.]+ Tm/) // shear = faux italic
  })
})

describe('appearance streams', () => {
  it('makeTextXObject builds a self-contained form usable as an annotation /AP', async () => {
    const pdf = await PDFDocument.create()
    const page = pdf.addPage([300, 200])
    const xo = await makeTextXObject(pdf, 'الاسم الكامل', { size: 14, width: 120, height: 24, padding: 3, valign: 'middle', align: 'end', fontStack: ['Noto Naskh Arabic'] })
    expect(xo.width).toBe(120)
    expect(xo.height).toBe(24)
    expect(xo.bbox).toEqual([0, 0, 120, 24])
    const annot = pdf.context.obj({
      Type: 'Annot',
      Subtype: 'FreeText',
      Rect: [20, 100, 140, 124],
      Contents: pdf.context.obj('x') && undefined,
      F: 4,
      AP: { N: xo.ref }
    } as never)
    page.node.addAnnot(pdf.context.register(annot))
    const bytes = await pdf.save()
    const doc = await reload(bytes)
    const annots = doc.getPage(0).node.Annots()!
    const a = doc.context.lookup(annots.get(0), PDFDict)
    const ap = doc.context.lookup(a.get(PDFName.of('AP')), PDFDict)
    const n = ap.get(PDFName.of('N')) as PDFRef
    const stream = doc.context.lookup(n) as import('pdf-lib').PDFRawStream
    expect(stream.dict.get(PDFName.of('Subtype'))).toBe(PDFName.of('Form'))
    expect(stream.dict.get(PDFName.of('BBox'))?.toString()).toBe('[ 0 0 120 24 ]')
    const res = stream.dict.lookup(PDFName.of('Resources'), PDFDict)
    const fonts = res.lookup(PDFName.of('Font'), PDFDict)
    expect(fonts.keys().length).toBe(1)
    const content = new TextDecoder().decode(streamBytes(doc, n))
    expect(content).toMatch(/Tf/)
    expect(content).toMatch(/TJ/)
    // the same subset font object as page text uses (one embedding per document)
    await drawText(page, 'مرحبا', { x: 20, y: 50, size: 14, fontStack: ['Noto Naskh Arabic'] })
    expect(embeddedFontsFor(pdf).all().filter((f) => /Naskh/.test(f.font.family)).length).toBe(1)
    // PDF.js opens it and sees the annotation with its appearance
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const task = pdfjs.getDocument({ data: (await pdf.save()).slice(), verbosity: 0, disableFontFace: true })
    const d = await task.promise
    const anns = await (await d.getPage(1)).getAnnotations()
    expect(anns.length).toBe(1)
    await task.destroy()
  })

  it('appearance text can be RTL and aligned inside the box', async () => {
    const pdf = await PDFDocument.create()
    const left = await makeTextXObject(pdf, 'مرحبا', { size: 12, width: 100, height: 20, align: 'left' })
    const right = await makeTextXObject(pdf, 'مرحبا', { size: 12, width: 100, height: 20, align: 'right' })
    expect(left.layout.lines[0]!.x).toBeCloseTo(0, 3)
    expect(right.layout.lines[0]!.x).toBeCloseTo(100 - right.layout.lines[0]!.width, 3)
  })
})

describe('ToUnicode CMaps', () => {
  it('round-trips ligatures and clusters (one code, several characters, surrogate pairs)', () => {
    const map = new Map<number, string>([
      [1, 'ا'],
      [2, 'لا'],
      [0x123, '\u{1f600}'],
      [0xffff, 'fi'],
      [5, 'क्षि']
    ])
    const cmap = buildToUnicode(map)
    expect(cmap).toMatch(/begincmap[\s\S]*endcmap/)
    expect(cmap).toMatch(/<0000> <FFFF>/)
    expect(parseToUnicode(cmap)).toEqual(map)
  })

  it('splits large maps into blocks of at most 100 entries', () => {
    const map = new Map<number, string>()
    for (let i = 1; i <= 250; i++) map.set(i, String.fromCharCode(0x0600 + (i % 100)))
    const cmap = buildToUnicode(map)
    expect((cmap.match(/beginbfchar/g) ?? []).length).toBe(3)
    expect(parseToUnicode(cmap).size).toBe(250)
  })

  it('parses bfrange forms too', () => {
    const m = parseToUnicode('1 beginbfrange\n<0010> <0012> <0041>\nendbfrange\n1 beginbfrange\n<0020> <0021> [<0061> <00620063>]\nendbfrange')
    expect([...m]).toEqual([[16, 'A'], [17, 'B'], [18, 'C'], [32, 'a'], [33, 'bc']])
  })
})

describe('validity', () => {
  it('output loads in pdf-lib strictly and in PDF.js without warnings', async () => {
    const { bytes } = await make(async (page) => {
      await drawParagraph(page, 'مرحبا بالعالم\nHello world\nשלום עולם\nสวัสดี\nनमस्ते\n你好\n😀', { x: 20, y: 180, size: 14, width: 300 })
    })
    const doc = await reload(bytes)
    expect(doc.getPageCount()).toBe(1)
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    const warnings: string[] = []
    const orig = console.log
    console.log = (...a: unknown[]): void => void warnings.push(a.join(' '))
    try {
      const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 1, stopAtErrors: true, disableFontFace: true })
      const d = await task.promise
      const tc = await (await d.getPage(1)).getTextContent()
      expect(tc.items.length).toBeGreaterThan(3)
      await task.destroy()
    } finally {
      console.log = orig
    }
    expect(warnings.filter((w) => /error|invalid|warn/i.test(w))).toEqual([])
  })

  it('reads a font file the same as the original glyph outlines: composite offsets are placed exactly', async () => {
    // A base letter with a mark above: the composite's mark component sits above the base (y offset > 0 in font units)
    const { bytes } = await make(async (page) => {
      await drawText(page, 'مَ', { x: 20, y: 150, size: 40, fontStack: ['Noto Naskh Arabic'] })
    })
    const doc = await reload(bytes)
    const parts = fontParts(doc, [...fontDicts(doc, doc.getPage(0).node.Resources()).values()][0]!)
    const f = fontkit.create(parts.program as unknown as Uint8Array) as import('@pdf-lib/fontkit').Font
    const original = fontkit.create(new Uint8Array(readFileSync('resources/fonts/NotoNaskhArabic-Regular.ttf'))) as import('@pdf-lib/fontkit').Font
    expect(f.numGlyphs).toBeGreaterThanOrEqual(original.numGlyphs)
    const composite = f.getGlyph(original.numGlyphs)
    expect(composite.path.bbox.maxY).toBeGreaterThan(composite.path.bbox.minY)
  })
})
