import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { bodyPlaceholder, buildPptx, picture, run, shape, solidFill, textBox, titlePlaceholder, xfrm } from '../support/pptxBuilder'
import { makePng, solid } from '../support/images'
import { flattenText, readPdf } from '../support/pdfText'
import { SOFFICE } from '../support/tools'

const fontsDir = resolve('resources/fonts')
const convert = (bytes: Uint8Array, name = 'deck.pptx', extra: Partial<Parameters<typeof convertOffice>[1]> = {}) => convertOffice({ name, bytes }, { fontsDir, ...extra })

/** Decoded content stream of a page, for checking colours and drawing operators. */
async function contentOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const c = doc.getPage(pageIndex).node.Contents() as unknown as PDFArray
  return Array.from({ length: c.size() }, (_, i) => Buffer.from(decodePDFRawStream(c.lookup(i, PDFRawStream)).decode()).toString('latin1')).join('\n')
}

describe('pptx: slides, text and inheritance', () => {
  it('writes one page per slide sized like the slide, with the text of every slide in order', async () => {
    const bytes = buildPptx({
      width: 9144000,
      height: 6858000,
      slides: [
        { shapes: titlePlaceholder(2, 'First slide') + bodyPlaceholder(3, ['Alpha point', 'Beta point']) },
        { shapes: textBox(2, 914400, 914400, 4572000, 914400, ['Second slide text']) },
        { shapes: titlePlaceholder(2, 'Third slide') }
      ]
    })
    const r = await convert(bytes)
    expect(r.pages).toBe(3)
    const doc = await PDFDocument.load(r.bytes)
    expect(doc.getPageCount()).toBe(3)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(720, 1)
    expect(pages[0].height).toBeCloseTo(540, 1)
    expect(pages[0].text).toContain('First slide')
    expect(pages[0].text).toContain('Alpha point')
    expect(pages[0].text).toContain('Beta point')
    expect(pages[1].text).toBe('Second slide text')
    expect(pages[2].text).toBe('Third slide')
    expect(embeddedFonts.some((f) => /Carlito|Caladea/.test(f))).toBe(true)
  })

  it('uses a widescreen slide size and positions a text box where the file puts it', async () => {
    const bytes = buildPptx({
      width: 12192000,
      height: 6858000,
      slides: [{ shapes: textBox(2, 1270000, 2540000, 3810000, 508000, ['Positioned']) }]
    })
    const r = await convert(bytes)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(960, 1)
    expect(pages[0].height).toBeCloseTo(540, 1)
    const it = pages[0].items.find((i) => i.str === 'Positioned')!
    expect(it.x).toBeCloseTo(100 + 7.2, 0) // 1270000 EMU = 100pt plus the 0.1" left inset
    expect(it.y).toBeGreaterThan(200) // 2540000 EMU = 200pt plus the first baseline
    expect(it.y).toBeLessThan(230)
    expect(it.size).toBeCloseTo(18, 0) // default text size from presentation defaults
  })

  it('inherits geometry, size, alignment and fonts of an empty title/body placeholder from layout and master', async () => {
    const bytes = buildPptx({
      slides: [{ shapes: titlePlaceholder(2, 'Inherited title') + bodyPlaceholder(3, ['Body text']) }]
    })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    const title = pages[0].items.find((i) => i.str === 'Inherited title')!
    // master title box: x 36pt..684pt, centred text at 44pt
    expect(title.size).toBeCloseTo(44, 0)
    expect(title.x + title.w / 2).toBeCloseTo(360, 0)
    expect(title.font).toMatch(/Caladea/) // +mj-lt = Cambria
    const body = pages[0].items.find((i) => i.str === 'Body text')!
    expect(body.size).toBeCloseTo(32, 0)
    // bullet at marL+indent = 0 (+ inset 7.2), text at marL = 27pt + inset
    expect(body.x).toBeCloseTo(36 + 7.2 + 27, 0)
    expect(body.y).toBeGreaterThan(126) // master body starts at y = 126pt
    expect(pages[0].text).toContain('•')
  })

  it('layout placeholder geometry overrides the master and the slide override wins over both', async () => {
    const layout = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr>${xfrm(1270000, 5080000, 6350000, 635000)}</p:spPr><p:txBody><a:bodyPr anchor="t"/><a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="2000"/></a:lvl1pPr></a:lstStyle><a:p><a:r><a:t>x</a:t></a:r></a:p></p:txBody></p:sp>`
    const bytes = buildPptx({
      layouts: [{ shapes: layout }],
      slides: [
        { shapes: titlePlaceholder(2, 'From layout') },
        { shapes: titlePlaceholder(2, 'From slide', `<p:spPr>${xfrm(2540000, 1270000, 3810000, 635000)}</p:spPr>`) }
      ]
    })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    const a = pages[0].items.find((i) => i.str === 'From layout')!
    expect(a.size).toBeCloseTo(20, 0)
    expect(a.x).toBeCloseTo(100 + 7.2, 0)
    expect(a.y).toBeGreaterThan(400) // 5080000 EMU = 400pt
    const b = pages[1].items.find((i) => i.str === 'From slide')!
    expect(b.y).toBeLessThan(160)
    expect(b.y).toBeGreaterThan(100)
    expect(b.x).toBeCloseTo(200 + 7.2, 0)
  })

  it('resolves theme colours, transforms and explicit colours for text and fills', async () => {
    const bytes = buildPptx({
      slides: [
        {
          shapes:
            textBox(2, 0, 0, 3000000, 500000, [`<a:p>${run('Accent', '<a:solidFill><a:schemeClr val="accent2"/></a:solidFill>')}${run('Red', '<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>')}</a:p>`]) +
            shape(3, 'rect', 0, 1000000, 1000000, 500000, `<a:solidFill><a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr></a:solidFill><a:ln><a:noFill/></a:ln>`)
        }
      ]
    })
    const c = await contentOf((await convert(bytes)).bytes)
    // accent2 = C0504D
    // (text colours are written by the text engine with 3 decimals, shapes by pdf-lib with more)
    expect(c).toMatch(/0\.75(29\d*|3) 0\.31(37\d*|4) 0\.30(19\d*|2) rg/)
    expect(c).toMatch(/1 0 0 rg/)
    // accent1 4F81BD with lumMod 50% is darker than the original blue
    const dark = [...c.matchAll(/(0\.\d+) (0\.\d+) (0\.\d+) rg\s+0 78\.7\d* m/g)]
    expect(dark.length).toBe(1)
    expect(parseFloat(dark[0][3])).toBeLessThan(0.45)
  })

  it('renders bullets, numbered lists, levels, bold/italic/underline runs and line breaks', async () => {
    const ps = [
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>${run('One')}</a:p>`,
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>${run('Two')}</a:p>`,
      `<a:p><a:pPr marL="742950" indent="-285750" lvl="1"><a:buFont typeface="Wingdings"/><a:buChar char="&#167;"/></a:pPr>${run('Nested')}</a:p>`,
      `<a:p><a:pPr marL="342900" indent="-342900"><a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/></a:pPr>${run('Three')}</a:p>`,
      `<a:p>${run('Bold', 'b="1"')}${run(' italic', 'i="1"')}${run(' under', 'u="sng"')}<a:br/>${run('after break')}</a:p>`
    ]
    const bytes = buildPptx({ slides: [{ shapes: textBox(2, 457200, 457200, 6000000, 3000000, ps) }] })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    const t = pages[0].text
    expect(t).toMatch(/1\.\s*One/)
    expect(t).toMatch(/2\.\s*Two/)
    expect(t).toMatch(/3\.\s*Three/) // numbering continues after the nested item
    expect(t).toContain('▪') // Wingdings § mapped to a real square bullet
    expect(t).toContain('Bold italic under')
    const bold = pages[0].items.find((i) => i.str.includes('Bold'))!
    expect(bold.font).toMatch(/Carlito-Bold|Bold/i)
    const nested = pages[0].items.find((i) => i.str === 'Nested')!
    const one = pages[0].items.find((i) => i.str === 'One')!
    expect(nested.x).toBeGreaterThan(one.x + 15)
    const after = pages[0].items.find((i) => i.str === 'after break')!
    const boldLine = pages[0].items.find((i) => i.str.includes('Bold'))!
    expect(after.y).toBeGreaterThan(boldLine.y + 10)
  })

  it('draws external hyperlinks as link annotations (and ignores unsafe schemes)', async () => {
    const bytes = buildPptx({
      slides: [
        {
          shapes: textBox(2, 0, 0, 5000000, 500000, [`<a:p><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId9"/></a:rPr><a:t>Visit site</a:t></a:r><a:r><a:rPr lang="en-US"><a:hlinkClick r:id="rId8"/></a:rPr><a:t> bad</a:t></a:r></a:p>`]),
          rels: [
            { id: 'rId9', type: 'hyperlink', target: 'https://example.com/', external: true },
            { id: 'rId8', type: 'hyperlink', target: 'javascript:alert(1)', external: true }
          ]
        }
      ]
    })
    const r = await convert(bytes)
    const doc = await PDFDocument.load(r.bytes)
    const annots = doc.getPage(0).node.Annots()
    expect(annots?.size()).toBe(1)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Visit site bad')
  })

  it('draws slide backgrounds from the slide, layout or master', async () => {
    const bytes = buildPptx({
      layouts: [{ shapes: '' }, { shapes: '', bg: `<p:bg><p:bgPr>${solidFill('00FF00')}<a:effectLst/></p:bgPr></p:bg>` }],
      slides: [{ shapes: '' }, { shapes: '', layout: 1 }, { shapes: '', bg: `<p:bg><p:bgPr>${solidFill('0000FF')}<a:effectLst/></p:bgPr></p:bg>`, layout: 1 }]
    })
    const r = await convert(bytes)
    const c0 = await contentOf(r.bytes, 0)
    const c1 = await contentOf(r.bytes, 1)
    const c2 = await contentOf(r.bytes, 2)
    expect(c0).not.toMatch(/0 1 0 rg/) // white theme background: nothing drawn
    expect(c1).toMatch(/0 1 0 rg/)
    expect(c2).toMatch(/0 0 1 rg/)
    expect(c2).not.toMatch(/0 1 0 rg/)
  })

  it('draws master/layout shapes under slide shapes and honours showMasterSp="0"', async () => {
    const masterShapes = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Logo text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 6300000, 3000000, 400000)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Company footer</a:t></a:r></a:p></p:txBody></p:sp>`
    const layoutShapes = `<p:sp><p:nvSpPr><p:cNvPr id="9" name="Layout text"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 3000000, 400000)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Layout mark</a:t></a:r></a:p></p:txBody></p:sp>`
    const bytes = buildPptx({
      masterShapes,
      layouts: [{ shapes: layoutShapes }],
      slides: [{ shapes: textBox(2, 0, 3000000, 2000000, 400000, ['Slide text']) }, { shapes: textBox(2, 0, 3000000, 2000000, 400000, ['Plain']), attrs: 'showMasterSp="0"' }]
    })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    expect(pages[0].text).toContain('Company footer')
    expect(pages[0].text).toContain('Layout mark')
    expect(pages[0].text).toContain('Slide text')
    expect(pages[1].text).toBe('Plain')
    // master drawn first: its text is earlier in the item order than the slide text
    const order = pages[0].items.map((i) => i.str)
    expect(order.indexOf('Company footer')).toBeLessThan(order.indexOf('Slide text'))
  })

  it('writes the slide number field with the real number', async () => {
    const fld = `<p:sp><p:nvSpPr><p:cNvPr id="5" name="Number"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 1000000, 300000)}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum"><a:rPr lang="en-US"/><a:t>‹#›</a:t></a:fld></a:p></p:txBody></p:sp>`
    const r = await convert(buildPptx({ slides: [{ shapes: fld }, { shapes: fld }] }))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].text).toBe('1')
    expect(pages[1].text).toBe('2')
  })

  it('skips hidden slides with a warning', async () => {
    const r = await convert(buildPptx({ slides: [{ shapes: textBox(2, 0, 0, 2000000, 400000, ['shown']) }, { shapes: textBox(2, 0, 0, 2000000, 400000, ['secret']), attrs: 'show="0"' }, { shapes: textBox(2, 0, 0, 2000000, 400000, ['also shown']) }] }))
    expect(r.pages).toBe(2)
    expect(r.warnings.join('\n')).toMatch(/Hidden slide 2 was skipped/)
    expect(flattenText((await readPdf(r.bytes)).pages)).not.toContain('secret')
  })

  it('never loses text that overflows its box, and shrinks normAutofit text using fontScale', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Overflowing paragraph number ${i + 1}`)
    const box = (auto: string): string => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Body"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(457200, 457200, 6000000, 1000000)}</p:spPr><p:txBody><a:bodyPr wrap="square">${auto}</a:bodyPr><a:lstStyle/>${long.map((t) => `<a:p>${run(t)}</a:p>`).join('')}</p:txBody></p:sp>`
    const plain = await readPdf((await convert(buildPptx({ slides: [{ shapes: box('') }] }))).bytes)
    for (const t of long) expect(plain.pages[0].text.replace(/\s+/g, ' ')).toContain(t)
    // the box is only 79pt tall but the text runs on below it (nothing is clipped or dropped)
    expect(plain.pages[0].items[plain.pages[0].items.length - 1].y).toBeGreaterThan(36 + 79 + 100)
    const scaled = await readPdf((await convert(buildPptx({ slides: [{ shapes: box('<a:normAutofit fontScale="50000" lnSpcReduction="20000"/>') }] }))).bytes)
    const size = scaled.pages[0].items[0].size
    expect(size).toBeCloseTo(9, 0)
    const auto = await readPdf((await convert(buildPptx({ slides: [{ shapes: box('<a:normAutofit/>') }] }))).bytes)
    expect(auto.pages[0].items[0].size).toBeLessThan(18)
    expect(flattenText(auto.pages)).toContain('number 12')
  })

  it('handles no-wrap text boxes: long lines stay on one line', async () => {
    const bytes = buildPptx({ slides: [{ shapes: `<p:sp><p:nvSpPr><p:cNvPr id="2" name="NoWrap"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 0, 500000, 400000)}</p:spPr><p:txBody><a:bodyPr wrap="none"/><a:lstStyle/><a:p>${run('A very long line that does not wrap because wrap is none')}</a:p></p:txBody></p:sp>` }] })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    expect(pages[0].text).toBe('A very long line that does not wrap because wrap is none')
  })

  it('warns about vertical text, shadows and gradient fills instead of dropping content silently', async () => {
    const shadow = `<a:solidFill><a:srgbClr val="00FF00"/></a:solidFill><a:effectLst><a:outerShdw blurRad="50800" dist="38100"><a:srgbClr val="000000"/></a:outerShdw></a:effectLst>`
    const grad = `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill>`
    const vert = `<p:sp><p:nvSpPr><p:cNvPr id="4" name="V"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(0, 2000000, 2500000, 2000000)}</p:spPr><p:txBody><a:bodyPr vert="vert270"/><a:lstStyle/><a:p>${run('Vertical words')}</a:p></p:txBody></p:sp>`
    const r = await convert(buildPptx({ slides: [{ shapes: shape(2, 'rect', 0, 0, 900000, 900000, shadow) + shape(3, 'rect', 1000000, 0, 900000, 900000, grad) + vert }] }))
    const w = r.warnings.join('\n')
    expect(w).toMatch(/Shadows, glow/)
    expect(w).toMatch(/Gradient fills/)
    expect(w).toMatch(/Vertical or rotated text/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Vertical words')
  })

  it('stops when cancelled and rejects files that are not presentations', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(convert(buildPptx({ slides: [{ shapes: '' }] }), 'a.pptx', { signal: ac.signal })).rejects.toThrow('Cancelled')
    await expect(convert(new TextEncoder().encode('this is not a zip file'), 'bad.pptx')).rejects.toThrow(/damaged or is not a valid Office file/)
  })
})


describe.skipIf(!existsSync(SOFFICE))('pptx: comparison with real LibreOffice', () => {
  it('produces the same page count, page size and text (at similar positions) as LibreOffice for a realistic slide', async () => {
    const png = makePng(60, 30, (x, y) => [x * 4, y * 8, 200, 255])
    const cell = (t: string): string => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${run(t)}</a:p></a:txBody><a:tcPr/></a:tc>`
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="3500000"/><a:ext cx="5486400" cy="1219200"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid><a:tr h="370840">${cell('Name')}${cell('Qty')}${cell('Price')}</a:tr><a:tr h="370840">${cell('Apple')}${cell('3')}${cell('1.50')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const pptx = buildPptx({
      media: { 'ppt/media/image1.png': png },
      slides: [
        {
          shapes:
            titlePlaceholder(2, 'Quarterly Review') +
            bodyPlaceholder(3, [`<a:p>${run('Highlights', 'b="1"')}</a:p>`, `<a:p><a:pPr lvl="1"/>${run('Revenue up twelve percent')}</a:p>`], `<p:spPr>${xfrm(457200, 1400000, 5000000, 1800000)}</p:spPr>`) +
            tbl +
            shape(10, 'ellipse', 6500000, 1500000, 1800000, 900000, solidFill('F79646'), 'Circle') +
            picture(13, 'rId5', 6500000, 4800000, 1800000, 900000),
          rels: [{ id: 'rId5', type: 'image', target: '../media/image1.png' }]
        },
        { shapes: textBox(2, 914400, 914400, 4572000, 914400, ['Second slide text']) }
      ]
    })
    const tmp = mkdtempSync(join(tmpdir(), 'epdf-pptx-'))
    try {
      mkdirSync(join(tmp, 'profile'))
      const src = join(tmp, 'in.pptx')
      writeFileSync(src, pptx)
      execFileSync(SOFFICE, ['--headless', '--convert-to', 'pdf', '--outdir', tmp, `-env:UserInstallation=file:///${tmp.replace(/\\/g, '/')}/profile`, src], { timeout: 120000, stdio: 'ignore' })
      const lo = await readPdf(new Uint8Array(readFileSync(join(tmp, 'in.pdf'))))
      const ours = await readPdf((await convert(pptx, 'in.pptx')).bytes)
      expect(ours.pages.length).toBe(lo.pages.length)
      expect(ours.pages[0].width).toBeCloseTo(lo.pages[0].width, 0)
      expect(ours.pages[0].height).toBeCloseTo(lo.pages[0].height, 0)
      const words = (t: string): string[] => t.toLowerCase().split(/\s+/).filter((w) => /[a-z0-9]/.test(w))
      const mine = new Set(words(flattenText(ours.pages)))
      for (const w of words(flattenText(lo.pages))) expect(mine.has(w), `word “${w}” from LibreOffice is missing`).toBe(true)
      for (const s of ['Quarterly Review', 'Highlights', 'Name', 'Apple']) {
        const a = ours.pages[0].items.find((i) => i.str.includes(s))!
        const b = lo.pages[0].items.find((i) => i.str.includes(s))!
        console.log(`[fidelity] pptx "${s}": dx=${(a.x - b.x).toFixed(2)} dy=${(a.y - b.y).toFixed(2)} dsize=${(a.size - b.size).toFixed(2)}`)
        expect(Math.abs(a.x - b.x), `x of ${s}`).toBeLessThan(10)
        expect(Math.abs(a.y - b.y), `y of ${s}`).toBeLessThan(12)
        expect(Math.abs(a.size - b.size), `size of ${s}`).toBeLessThan(1.5)
      }
      expect(ours.pages[0].imageCount).toBe(lo.pages[0].imageCount)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 180000)
})

describe('pptx: shapes, pictures, groups, tables', () => {
  it('draws preset shapes as vector paths with fills, strokes and centred text', async () => {
    const bytes = buildPptx({
      slides: [
        {
          shapes:
            shape(2, 'ellipse', 914400, 914400, 1828800, 914400, `${solidFill('FFCC00')}<a:ln w="25400">${solidFill('000000')}</a:ln>`, 'Oval text') +
            shape(3, 'roundRect', 3000000, 914400, 1828800, 914400, solidFill('CCCCFF')) +
            shape(4, 'rightArrow', 914400, 2500000, 1828800, 914400, solidFill('FF0000')) +
            shape(5, 'triangle', 3000000, 2500000, 914400, 914400, solidFill('00FF00'))
        }
      ]
    })
    const r = await convert(bytes)
    const c = await contentOf(r.bytes)
    expect(c.match(/ c\n/g)?.length ?? 0).toBeGreaterThanOrEqual(8) // ellipse + rounded rectangle curves
    expect(c).toMatch(/1 0.8 0 rg/)
    expect(c).toMatch(/2 w/) // 25400 EMU = 2pt outline
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].items.find((i) => i.str === 'Oval text')!
    expect(t.x + t.w / 2).toBeCloseTo(72 + 72, 0) // centred in a 144pt wide ellipse starting at 72pt
    expect(r.warnings).toEqual([])
  })

  it('falls back to an outlined rectangle plus a warning for unsupported shape types', async () => {
    const r = await convert(buildPptx({ slides: [{ shapes: shape(2, 'cloud', 0, 0, 1000000, 800000, solidFill('CCCCCC'), 'Cloud text') }] }))
    expect(r.warnings.join('\n')).toMatch(/shape type “cloud”.*drawn as a rectangle/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Cloud text')
  })

  it('draws lines and connectors, with flips and arrow heads', async () => {
    const cxn = (id: number, prst: string, x: number, y: number, w: number, h: number, extra: string, ln: string): string =>
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="C${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(x, y, w, h, extra)}<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom>${ln}</p:spPr></p:cxnSp>`
    const ln = `<a:ln w="19050">${solidFill('FF0000')}<a:tailEnd type="triangle"/></a:ln>`
    const r = await convert(buildPptx({ slides: [{ shapes: cxn(2, 'straightConnector1', 1270000, 1270000, 2540000, 1270000, '', ln) + cxn(3, 'bentConnector3', 1270000, 3810000, 2540000, 1270000, ' flipV="1"', ln) }] }))
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/100 100 m\s+300 200 l/) // 1270000 EMU = 100pt, 2540000 = 200pt
    expect(c).toMatch(/1.5 w/)
    expect(c).toMatch(/100 400 m\s+200 400 l\s+200 300 l\s+300 300 l/) // flipV: starts at the bottom left
    expect(c.match(/^f$/gm)?.length ?? 0).toBeGreaterThanOrEqual(2) // arrow heads are filled paths
    expect(r.warnings).toEqual([])
  })

  it('embeds PNG/JPEG pictures at their position with cropping, and reports unsupported formats', async () => {
    const png = makePng(40, 20, solid(255, 0, 0))
    const bytes = buildPptx({
      media: { 'ppt/media/image1.png': png, 'ppt/media/image2.gif': new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]) },
      slides: [
        {
          shapes: picture(2, 'rId5', 1270000, 1270000, 2540000, 1270000) + picture(3, 'rId6', 5080000, 1270000, 1270000, 1270000, '', '<a:srcRect l="25000" r="25000"/>') + picture(4, 'rId7', 0, 5000000, 1270000, 1270000),
          rels: [
            { id: 'rId5', type: 'image', target: '../media/image1.png' },
            { id: 'rId6', type: 'image', target: '../media/image1.png' },
            { id: 'rId7', type: 'image', target: '../media/image2.gif' }
          ]
        }
      ]
    })
    const r = await convert(bytes)
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(2)
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/200 0 0 -100 100 200 cm/) // 2540000 x 1270000 EMU at (100, 100)
    expect(r.warnings.join('\n')).toMatch(/“Picture 4” could not be drawn \(gif pictures cannot be embedded\)/)
    expect(pages[0].text).toContain('Picture (GIF)')
  })

  it('scales group children by chExt/ext, nests groups and rotates shapes', async () => {
    const grp = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="1270000" y="1270000"/><a:ext cx="2540000" cy="2540000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr>${shape(11, 'rect', 0, 0, 635000, 635000, solidFill('FF0000'))}</p:grpSp>`
    const rot = shape(20, 'rect', 5080000, 1270000, 1270000, 635000, solidFill('0000FF'), '', ' rot="5400000"')
    const r = await convert(buildPptx({ slides: [{ shapes: grp + rot }] }))
    const c = await contentOf(r.bytes)
    // child 635000 -> scaled x2 = 1270000 EMU = 100pt square at 100,100
    expect(c).toMatch(/100 100 m\s+200 100 l\s+200 200 l\s+100 200 l/)
    // rotated 90 degrees about its centre (cx = 400+50 = 450, cy = 100+25 = 125): cm with cos=0 sin=1
    expect(c).toMatch(/[\d.e-]+ 1 -1 [\d.e-]+ 575 -325 cm/)
  })

  it('lays out tables: column widths, spans, fills, borders, header style and text', async () => {
    const cell = (t: string, extra = '', attrs = ''): string => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${t ? run(t) : '<a:endParaRPr lang="en-US"/>'}</a:p></a:txBody><a:tcPr${extra ? '' : ''}>${extra}</a:tcPr></a:tc>`
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="5486400" cy="1219200"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="1"><a:tableStyleId>{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}</a:tableStyleId></a:tblPr><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid><a:tr h="370840">${cell('Name')}${cell('Qty')}${cell('Price')}</a:tr><a:tr h="370840">${cell('Apple')}${cell('3')}${cell('1.50')}</a:tr><a:tr h="370840">${cell('Merged across two', '', ' gridSpan="2"')}${cell('', '', ' hMerge="1"')}${cell('9.99')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const r = await convert(buildPptx({ slides: [{ shapes: tbl }] }))
    const { pages } = await readPdf(r.bytes)
    const items = pages[0].items
    const name = items.find((i) => i.str === 'Name')!
    const qty = items.find((i) => i.str === 'Qty')!
    const price = items.find((i) => i.str === 'Price')!
    expect(qty.x - name.x).toBeCloseTo(144, 0) // 1828800 EMU column
    expect(price.x - qty.x).toBeCloseTo(144, 0)
    expect(name.font).toMatch(/Bold/i) // header row of Medium Style 2 is bold
    const apple = items.find((i) => i.str === 'Apple')!
    expect(apple.y).toBeGreaterThan(name.y + 20)
    const merged = items.find((i) => i.str === 'Merged across two')!
    const last = items.find((i) => i.str === '9.99')!
    expect(last.x).toBeCloseTo(price.x, 0) // third column, after the two-column span
    expect(merged.x).toBeCloseTo(name.x, 0)
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/0\.30980\d* 0\.50588\d* 0\.74117\d* rg/) // accent1 4F81BD header fill
    expect(r.warnings).toEqual([])
  })

  it('shows labelled placeholders and warnings for charts, SmartArt and embedded objects', async () => {
    const frame = (id: number, name: string, uri: string): string =>
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${id * 500000}" y="914400"/><a:ext cx="2000000" cy="1500000"/></p:xfrm><a:graphic><a:graphicData uri="${uri}"/></a:graphic></p:graphicFrame>`
    const r = await convert(
      buildPptx({ slides: [{ shapes: frame(2, 'Sales Chart', 'http://schemas.openxmlformats.org/drawingml/2006/chart') + frame(6, 'Org', 'http://schemas.openxmlformats.org/drawingml/2006/diagram') }] })
    )
    const w = r.warnings.join('\n')
    expect(w).toMatch(/Chart “Sales Chart” on slide 1 is not rendered/)
    expect(w).toMatch(/SmartArt diagram “Org”/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Chart: Sales Chart')
  })

  it('takes fill, outline, text colour and effects from the shape style references (as PowerPoint writes them)', async () => {
    const styled = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Styled"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(1270000, 1270000, 2540000, 1270000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:style><a:lnRef idx="2"><a:schemeClr val="accent1"><a:shade val="50000"/></a:schemeClr></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef><a:effectRef idx="2"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></p:style><p:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>${run('Styled text')}</a:p></p:txBody></p:sp>`
    const r = await convert(buildPptx({ slides: [{ shapes: styled }] }))
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/0\.30980\d* 0\.50588\d* 0\.74117\d* rg/) // accent1 fill
    expect(c).toMatch(/2 w/) // theme line style 2 = 25400 EMU
    expect(c).toMatch(/1 1 1 rg/) // fontRef lt1: white text
    expect(r.warnings.join('\n')).toMatch(/Shadows, glow/)
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].items.find((i) => i.str === 'Styled text')!
    expect(t.x + t.w / 2).toBeCloseTo(100 + 100, 0)
  })

  it('applies fill transparency, picture flips, nested group rotation and slide-level list styles', async () => {
    const png = makePng(10, 10, solid(0, 0, 255))
    const half = `<a:solidFill><a:srgbClr val="FF0000"><a:alpha val="50000"/></a:srgbClr></a:solidFill>`
    const inner = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="21" name="Inner"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm rot="5400000"><a:off x="2540000" y="2540000"/><a:ext cx="1270000" cy="1270000"/><a:chOff x="0" y="0"/><a:chExt cx="1270000" cy="1270000"/></a:xfrm></p:grpSpPr>${shape(22, 'rect', 0, 0, 1270000, 635000, solidFill('00FF00'))}</p:grpSp>`
    const outer = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="20" name="Outer"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="6350000" cy="6350000"/><a:chOff x="0" y="0"/><a:chExt cx="6350000" cy="6350000"/></a:xfrm></p:grpSpPr>${inner}</p:grpSp>`
    const lst = `<a:lvl1pPr><a:defRPr sz="2000" b="1"/></a:lvl1pPr>`
    const r = await convert(
      buildPptx({
        media: { 'ppt/media/image1.png': png },
        slides: [
          {
            shapes:
              shape(2, 'rect', 0, 0, 1270000, 1270000, half) +
              picture(3, 'rId5', 1270000, 1270000, 2540000, 1270000).replace('<p:spPr>', '<p:spPr>').replace('<a:xfrm>', '<a:xfrm flipH="1">') +
              outer +
              textBox(30, 0, 5500000, 3000000, 500000, ['Styled by slide list style'], { lst }),
            rels: [{ id: 'rId5', type: 'image', target: '../media/image1.png' }]
          }
        ]
      })
    )
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/\/GS1 gs/) // 50% alpha uses an ExtGState
    expect(c).toMatch(/-200 0 0 -100 300 200 cm/) // flipH picture: mirrored via a negative width
    expect(c).toMatch(/[\d.e-]+ 1 -1 [\d.e-]+ [\d.-]+ [\d.-]+ cm/) // the inner group is rotated 90 degrees
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].items.find((i) => i.str === 'Styled by slide list style')!
    expect(t.size).toBeCloseTo(20, 0)
    expect(t.font).toMatch(/Bold/i)
  })

  it('renders superscript, subscript, strike-through, caps and character spacing', async () => {
    const p = `<a:p>${run('x')}${run('2', 'baseline="30000"')}${run(' H')}${run('2', 'baseline="-25000"')}${run(' gone', 'strike="sngStrike"')}${run(' caps', 'cap="all"')}${run(' wide', 'spc="300"')}</a:p>`
    const r = await convert(buildPptx({ slides: [{ shapes: textBox(2, 0, 0, 6000000, 800000, [p]) }] }))
    const { pages } = await readPdf(r.bytes)
    const sup = pages[0].items.find((i) => i.str === '2')!
    expect(sup.size).toBeCloseTo(18 * 0.65, 0)
    expect(pages[0].text).toContain('CAPS')
    expect(pages[0].text).toContain('gone')
    const c = await contentOf(r.bytes)
    expect(c.match(/ l\nS/g)?.length ?? 0).toBeGreaterThanOrEqual(1) // strike-through line
  })

  it('handles row-spanning cells and explicit cell borders in tables', async () => {
    const tc = (t: string, attrs = '', pr = ''): string => `<a:tc${attrs}><a:txBody><a:bodyPr/><a:lstStyle/><a:p>${t ? run(t) : '<a:endParaRPr lang="en-US"/>'}</a:p></a:txBody><a:tcPr>${pr}</a:tcPr></a:tc>`
    const ln = `<a:lnB w="38100"><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></a:lnB>`
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="T"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="914400" y="914400"/><a:ext cx="3657600" cy="1000000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid><a:tr h="400000">${tc('Tall', ' rowSpan="2"')}${tc('Top', '', ln)}</a:tr><a:tr h="400000">${tc('', ' vMerge="1"')}${tc('Bottom')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const r = await convert(buildPptx({ slides: [{ shapes: tbl }] }))
    const { pages } = await readPdf(r.bytes)
    const tall = pages[0].items.find((i) => i.str === 'Tall')!
    const top = pages[0].items.find((i) => i.str === 'Top')!
    const bottom = pages[0].items.find((i) => i.str === 'Bottom')!
    expect(bottom.x).toBeCloseTo(top.x, 0)
    expect(bottom.y).toBeGreaterThan(top.y + 20)
    expect(top.x - tall.x).toBeCloseTo(144, 0)
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/1 0 0 RG/)
    expect(c).toMatch(/3 w/) // 38100 EMU bottom border of the first-row cell
  })

  it('draws custom geometry paths scaled to the shape', async () => {
    const cust = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="50" y="100"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>`
    const sp = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Custom"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(1270000, 1270000, 2540000, 1270000)}${cust}${solidFill('FF00FF')}</p:spPr></p:sp>`
    const r = await convert(buildPptx({ slides: [{ shapes: sp }] }))
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/100 100 m\s+300 100 l\s+200 200 l\s+h/)
    expect(c).toMatch(/1 0 1 rg/)
  })
})
