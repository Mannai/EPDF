import { zlibSync } from 'fflate'
import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { pureCodec } from '../../src/renderer/src/features/compress/pdf/codec'
import { compressPdf } from '../../src/renderer/src/features/compress/pdf/compress'
import { convertInlineImages } from '../../src/renderer/src/features/compress/pdf/inline'
import { PRESETS } from '../../src/renderer/src/features/compress/pdf/options'
import { resizeBox } from '../../src/renderer/src/features/compress/pdf/raster'
import { decodeStream } from '../../src/renderer/src/features/compress/pdf/streams'
import { imagesOf, photoRGB, rng } from './compressHelpers'
import { pdfjsImages, pdfjsText } from './compressPdfjs'

const N = (s: string): PDFName => PDFName.of(s)
const noise = (n: number, seed: number): Uint8Array => {
  const r = rng(seed)
  return Uint8Array.from({ length: n }, () => Math.floor(r() * 256))
}
const latin = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255)
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((a, x) => a + x.length, 0))
  let o = 0
  for (const x of p) (out.set(x, o), (o += x.length))
  return out
}

/** A one-page document whose content stream draws inline images. */
async function inlineDoc(content: Uint8Array, resources: Record<string, unknown> = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([612, 792])
  const ctx = doc.context
  page.node.set(N('Resources'), ctx.obj({ Font: { F1: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' } }, ...resources }))
  page.node.set(N('Contents'), ctx.register(ctx.stream(content)))
  return doc.save()
}

const rgbInline = (w: number, h: number, px: Uint8Array, extra = ''): Uint8Array =>
  cat(latin(`BI /W ${w} /H ${h} /BPC 8 /CS /RGB /F /Fl ${extra}ID\n`), zlibSync(px), latin('\nEI\n'))

describe('inline images', () => {
  it('a large inline image becomes an XObject at the same place, then is reduced like any picture', async () => {
    const w = 600
    const h = 400
    const px = photoRGB(w, h, 31, 12)
    const content = cat(latin('BT /F1 14 Tf 40 740 Td (Inline image page) Tj ET\nq 216 0 0 144 40 500 cm\n'), rgbInline(w, h, px), latin('Q\n'))
    const input = await inlineDoc(content)
    const r = await compressPdf(input, PRESETS.balanced, { codec: pureCodec })
    expect(r.kept).toBe('result')
    expect(r.stats.images.inlineConverted).toBe(1)
    expect(r.stats.images.downsampled).toBe(1) // 600 px over 3 in = 200 dpi > 187.5
    const out = await PDFDocument.load(r.bytes)
    const imgs = imagesOf(out)
    expect(imgs).toHaveLength(1)
    expect((imgs[0].dict.get(N('Width')) as PDFNumber).asNumber()).toBe(450)
    expect(r.bytes.length).toBeLessThan(input.length / 4)
    // the page still shows its text and the picture, resembling the original
    expect(await pdfjsText(r.bytes)).toBe('Inline image page')
    const [shown] = await pdfjsImages(r.bytes)
    expect(shown.width).toBe(450)
    const ref = resizeBox(px, w, h, 3, 450, 300)
    let se = 0
    for (let i = 0; i < 450 * 300; i++) for (let c = 0; c < 3; c++) se += (ref[i * 3 + c] - shown.data[i * shown.channels + c]) ** 2
    expect(10 * Math.log10((255 * 255) / (se / (450 * 300 * 3)))).toBeGreaterThan(28)
    // the content stream no longer holds the BI block, and the operator that replaced it is a Do in the same position
    const page = out.getPage(0)
    const cs = decodeStream(out.context, page.node.lookup(N('Contents')) as PDFStream)!
    const txt = Buffer.from(cs).toString('latin1')
    expect(txt).not.toContain('BI /W')
    expect(txt).toMatch(/q 216 0 0 144 40 500 cm\s+\/EpdfInl1 Do\s+Q/)
  })

  it('small inline images (icons, glyph bitmaps) are left inline and untouched', async () => {
    const px = photoRGB(20, 20, 3)
    const content = cat(latin('q 20 0 0 20 40 500 cm\n'), rgbInline(20, 20, px), latin('Q\n'))
    const input = await inlineDoc(content)
    const doc = await PDFDocument.load(input)
    expect(convertInlineImages(doc)).toBe(0)
    expect(imagesOf(doc)).toHaveLength(0)
  })

  it('handles named colour spaces from the resource dictionary, abbreviations, Decode and image masks', async () => {
    const w = 400
    const h = 300
    const px = photoRGB(w, h, 8)
    const content = cat(
      latin('q 200 0 0 150 40 500 cm\n'),
      cat(latin(`BI /W ${w} /H ${h} /BPC 8 /CS /Cs1 /F [/Fl] /D [1 0 1 0 1 0] ID\n`), zlibSync(px), latin('\nEI\n')),
      latin('Q\nq 300 0 0 300 40 100 cm\n0 0 1 rg\n'),
      cat(latin('BI /W 512 /H 512 /IM true /BPC 1 /F /Fl ID\n'), zlibSync(noise(64 * 512, 4)), latin('\nEI\n')),
      latin('Q\n')
    )
    const input = await inlineDoc(content, { ColorSpace: { Cs1: 'DeviceRGB' } })
    const doc = await PDFDocument.load(input)
    expect(convertInlineImages(doc, 1000)).toBe(2)
    const imgs = imagesOf(doc)
    expect(imgs).toHaveLength(2)
    const color = imgs.find((i) => !i.dict.has(N('ImageMask')))!
    expect(String(color.dict.get(N('ColorSpace')))).toBe('/DeviceRGB')
    expect(String(color.dict.get(N('Filter')))).toBe('[ /FlateDecode ]')
    expect(String(color.dict.get(N('Decode')))).toBe('[ 1 0 1 0 1 0 ]')
    const mask = imgs.find((i) => i.dict.has(N('ImageMask')))!
    expect(String(mask.dict.get(N('ImageMask')))).toBe('true')
    expect((mask.dict.get(N('BitsPerComponent')) as PDFNumber).asNumber()).toBe(1)
    // each XObject holds exactly the original data
    const st = doc.context.lookup(color.ref) as PDFStream
    expect(Array.from(decodeStream(doc.context, st)!)).toEqual(Array.from(px))
    void PDFDict
    void PDFRef
  })

  it('indexed inline images with a hex palette convert to a valid Indexed colour space', async () => {
    const w = 128
    const h = 128
    const idx = noise(w * h, 5).map((v) => v & 3)
    const pal = '000000 ff0000 00ff00 0000ff'.replace(/ /g, '')
    const content = cat(latin('q 128 0 0 128 40 500 cm\n'), cat(latin(`BI /W ${w} /H ${h} /BPC 8 /CS [/I /RGB 3 <${pal}>] /F /Fl ID\n`), zlibSync(idx), latin('\nEI\n')), latin('Q\n'))
    const input = await inlineDoc(content)
    const doc = await PDFDocument.load(input)
    expect(convertInlineImages(doc, 1000)).toBe(1)
    const cs = String(imagesOf(doc)[0].dict.get(N('ColorSpace')))
    expect(cs).toContain('/Indexed')
    expect(cs).toContain('/DeviceRGB')
    expect(cs).toContain('<000000ff000000ff000000ff>')
    // and the result still opens and draws the image
    const reload = await doc.save()
    expect((await pdfjsImages(reload)).length).toBe(1)
  })

  it('content that cannot be parsed is left exactly as it was', async () => {
    const bad = cat(latin('q 10 0 0 10 0 0 cm\n'), rgbInline(600, 400, photoRGB(600, 400, 1)), latin('(unterminated'))
    const input = await inlineDoc(bad)
    const doc = await PDFDocument.load(input)
    expect(convertInlineImages(doc)).toBe(0)
  })
})
