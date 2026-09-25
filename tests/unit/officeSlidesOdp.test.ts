import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib'
import { describe, expect, it } from 'vitest'
import { convertOffice } from '../../src/main/features/create/office'
import { parseOdfTransform } from '../../src/main/features/create/office/odp'
import { buildOdp, customShape, frame, graphicStyle, para, span } from '../support/odpBuilder'
import { makePng, solid } from '../support/images'
import { flattenText, readPdf } from '../support/pdfText'
import { bodyPlaceholder, buildPptx, picture, shape, solidFill, textBox, titlePlaceholder } from '../support/pptxBuilder'

const fontsDir = resolve('resources/fonts')
const CM = 72 / 2.54
const convert = (bytes: Uint8Array, name = 'deck.odp', extra: Partial<Parameters<typeof convertOffice>[1]> = {}) => convertOffice({ name, bytes }, { fontsDir, ...extra })

async function contentOf(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  const doc = await PDFDocument.load(bytes)
  const c = doc.getPage(pageIndex).node.Contents() as unknown as PDFArray
  return Array.from({ length: c.size() }, (_, i) => Buffer.from(decodePDFRawStream(c.lookup(i, PDFRawStream)).decode()).toString('latin1')).join('\n')
}

const P1 = `<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/><style:text-properties fo:font-size="20pt" style:font-name="Calibri"/></style:style>`
const T_BOLD = `<style:style style:name="Tb" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#ff0000"/></style:style>`
const T_IT = `<style:style style:name="Ti" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid" fo:font-size="150%"/></style:style>`

describe('odf transform parsing', () => {
  it('applies transforms left to right and turns counter-clockwise radians into clockwise degrees', () => {
    const r = parseOdfTransform('rotate (-0.785398163397449) translate (15.251cm 13.122cm)')
    expect(r.rot).toBeCloseTo(45, 3)
    expect(r.tx).toBeCloseTo(15.251 * CM, 2)
    expect(r.ty).toBeCloseTo(13.122 * CM, 2)
    const r2 = parseOdfTransform('translate (1cm 0cm) rotate (1.5707963)')
    expect(r2.rot).toBeCloseTo(-90, 2)
    // translate first, then rotate about the origin: the translation is rotated too
    expect(r2.tx).toBeCloseTo(0, 2)
    expect(r2.ty).toBeCloseTo(-1 * CM, 2)
    expect(parseOdfTransform(undefined)).toEqual({ rot: 0, tx: 0, ty: 0, skew: false })
  })
})

describe('odp: slides and text', () => {
  it('writes one page per slide, sized from the page layout, with text where the frame is', async () => {
    const bytes = buildOdp({
      autoStyles: P1,
      slides: [{ body: frame(2, 3, 10, 2, para('Hello ODP', 'P1')) }, { body: frame(1, 1, 10, 2, para('Second slide')) }]
    })
    const r = await convert(bytes)
    expect(r.pages).toBe(2)
    const { pages, embeddedFonts } = await readPdf(r.bytes)
    expect(pages[0].width).toBeCloseTo(28 * CM, 1)
    expect(pages[0].height).toBeCloseTo(15.75 * CM, 1)
    const hello = pages[0].items.find((i) => i.str === 'Hello ODP')!
    expect(hello.size).toBeCloseTo(20, 0)
    expect(hello.x + hello.w / 2).toBeCloseTo((2 + 5) * CM, 0) // centred in the 10cm frame
    expect(hello.y).toBeGreaterThan(3 * CM)
    expect(pages[1].text).toBe('Second slide')
    expect(pages[1].items[0].size).toBeCloseTo(18, 0) // default style size
    expect(embeddedFonts.some((f) => /Carlito/.test(f))).toBe(true)
    expect(r.warnings).toEqual([])
  })

  it('applies span styles: bold, colour, italic, underline, relative size, spaces, tabs and line breaks', async () => {
    const spans = `Plain ${span('Bold', 'Tb')} ${span('Big', 'Ti')}<text:s text:c="3"/>gap<text:line-break/>next<text:tab/>tabbed`
    const bytes = buildOdp({ autoStyles: T_BOLD + T_IT, slides: [{ body: frame(1, 1, 20, 4, para('', '', spans)) }] })
    const r = await convert(bytes)
    const { pages } = await readPdf(r.bytes)
    const bold = pages[0].items.find((i) => i.str === 'Bold')!
    expect(bold.font).toMatch(/Bold/i)
    const big = pages[0].items.find((i) => i.str === 'Big')!
    expect(big.size).toBeCloseTo(27, 0) // 150% of 18pt
    expect(big.font).toMatch(/Italic/i)
    expect(pages[0].text).toContain('gap')
    const next = pages[0].items.find((i) => i.str.startsWith('next'))!
    const plain = pages[0].items.find((i) => i.str.startsWith('Plain'))!
    expect(next.y).toBeGreaterThan(plain.y + 10)
    expect(await contentOf(r.bytes)).toMatch(/1 0 0 rg/) // bold span is red
  })

  it('renders bullet and numbered lists with nesting and continues numbers within a list', async () => {
    const lists = `<text:list-style style:name="LB"><text:list-level-style-bullet text:level="1" text:bullet-char="•"><style:list-level-properties text:min-label-width="0.6cm"/></text:list-level-style-bullet><text:list-level-style-bullet text:level="2" text:bullet-char="–"><style:list-level-properties text:space-before="1cm" text:min-label-width="0.5cm"/></text:list-level-style-bullet></text:list-style><text:list-style style:name="LN"><text:list-level-style-number text:level="1" style:num-suffix="." style:num-format="1"><style:list-level-properties text:min-label-width="0.8cm"/></text:list-level-style-number></text:list-style>`
    const body = frame(
      1,
      1,
      20,
      10,
      `<text:list text:style-name="LB"><text:list-item><text:p>Alpha</text:p><text:list><text:list-item><text:p>Nested</text:p></text:list-item></text:list></text:list-item><text:list-item><text:p>Beta</text:p></text:list-item></text:list><text:list text:style-name="LN"><text:list-item><text:p>One</text:p></text:list-item><text:list-item><text:p>Two</text:p></text:list-item><text:list-item><text:p>Three</text:p></text:list-item></text:list>`
    )
    const r = await convert(buildOdp({ autoStyles: lists, slides: [{ body }] }))
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].text
    expect(t).toMatch(/•\s*Alpha/)
    expect(t).toMatch(/–\s*Nested/)
    expect(t).toMatch(/1\.\s*One/)
    expect(t).toMatch(/2\.\s*Two/)
    expect(t).toMatch(/3\.\s*Three/)
    const alpha = pages[0].items.find((i) => i.str.includes('Alpha'))!
    const nested = pages[0].items.find((i) => i.str.includes('Nested'))!
    expect(nested.x - alpha.x).toBeGreaterThan(0.9 * CM)
    expect(alpha.x).toBeCloseTo(1 * CM + 0.25 * CM, 0) // the bullet sits at the frame's text edge; the text follows after the label width
  })

  it('uses the list style nested in a presentation style for outline lists that have none of their own', async () => {
    const styles = `<style:style style:name="outl" style:family="presentation"><style:graphic-properties draw:fill="none" draw:stroke="none"><text:list-style style:name="outl"><text:list-level-style-bullet text:level="1" text:bullet-char="■"><style:list-level-properties text:min-label-width="0.9cm"/></text:list-level-style-bullet></text:list-style></style:graphic-properties></style:style>`
    const body = `<draw:frame draw:style-name="fr1" presentation:style-name="outl" presentation:class="outline" svg:width="12cm" svg:height="4cm" svg:x="1cm" svg:y="1cm"><draw:text-box><text:list><text:list-item><text:p>Outline item</text:p></text:list-item></text:list></draw:text-box></draw:frame>`
    const { pages } = await readPdf((await convert(buildOdp({ autoStyles: styles, slides: [{ body }] }))).bytes)
    expect(pages[0].text).toMatch(/■\s*Outline item/)
  })

  it('takes the geometry of a slide placeholder that has no position from the master page frame of the same class', async () => {
    const master = `<draw:frame draw:style-name="fr1" presentation:class="title" svg:width="20cm" svg:height="3cm" svg:x="4cm" svg:y="2cm"><draw:text-box><text:p>Master title prompt</text:p></draw:text-box></draw:frame>`
    const body = `<draw:frame draw:style-name="fr1" presentation:class="title"><draw:text-box><text:p>Inherited position</text:p></draw:text-box></draw:frame>`
    const { pages } = await readPdf((await convert(buildOdp({ masterShapes: master, slides: [{ body }] }))).bytes)
    const it = pages[0].items.find((i) => i.str === 'Inherited position')!
    expect(it.x).toBeCloseTo((4 + 0.25) * CM, 0)
    expect(it.y).toBeGreaterThan(2 * CM)
    expect(pages[0].text).not.toContain('Master title prompt')
  })

  it('draws hyperlinks as link annotations and refuses unsafe schemes', async () => {
    const body = frame(1, 1, 20, 3, `<text:p><text:a xlink:href="https://example.com/" xlink:type="simple">Good link</text:a> <text:a xlink:href="javascript:alert(1)" xlink:type="simple">Bad link</text:a></text:p>`)
    const r = await convert(buildOdp({ slides: [{ body }] }))
    const doc = await PDFDocument.load(r.bytes)
    expect(doc.getPage(0).node.Annots()?.size()).toBe(1)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Good link Bad link')
  })

  it('skips hidden slides with a warning and honours the slide background', async () => {
    const bytes = buildOdp({
      slides: [{ body: frame(1, 1, 5, 2, para('one')), attrs: 'draw:style-name="dp2"' }, { body: frame(1, 1, 5, 2, para('two')), attrs: 'presentation:visibility="hidden"' }, { body: frame(1, 1, 5, 2, para('three')) }]
    })
    const r = await convert(bytes)
    expect(r.pages).toBe(2)
    expect(r.warnings.join('\n')).toMatch(/Hidden slide 2 was skipped/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toBe('one three')
    expect(await contentOf(r.bytes, 0)).toMatch(/1 1 0 rg/) // slide 1 uses the yellow drawing-page fill
    expect(await contentOf(r.bytes, 1)).not.toMatch(/1 1 0 rg/)
  })

  it('draws master shapes under slide shapes, skips master placeholder prompts and shows the page number when enabled', async () => {
    const master = `<draw:frame draw:style-name="fr1" draw:layer="backgroundobjects" svg:width="8cm" svg:height="1cm" svg:x="1cm" svg:y="14cm"><draw:text-box><text:p>Company footer</text:p></draw:text-box></draw:frame><draw:frame draw:style-name="fr1" presentation:class="title" svg:width="20cm" svg:height="2cm" svg:x="1cm" svg:y="1cm"><draw:text-box><text:p>Click to edit the title</text:p></draw:text-box></draw:frame><draw:frame draw:style-name="fr1" presentation:class="page-number" svg:width="2cm" svg:height="1cm" svg:x="24cm" svg:y="14cm"><draw:text-box><text:p><text:page-number>&lt;number&gt;</text:page-number></text:p></draw:text-box></draw:frame>`
    const bytes = buildOdp({
      masterShapes: master,
      slides: [{ body: frame(1, 5, 5, 2, para('Slide A')) }, { body: frame(1, 5, 5, 2, para('Slide B')), attrs: 'draw:style-name="dp2"' }]
    })
    const { pages } = await readPdf((await convert(bytes)).bytes)
    expect(pages[0].text).toContain('Company footer')
    expect(pages[0].text).not.toContain('Click to edit')
    expect(pages[0].text).not.toContain('<number>')
    expect(pages[1].text).toContain('2') // page number frame enabled on slide 2
    const order = pages[0].items.map((i) => i.str)
    expect(order.indexOf('Company footer')).toBeLessThan(order.indexOf('Slide A'))
  })

  it('shrinks text that does not fit when the frame has shrink-to-fit, and never drops text otherwise', async () => {
    const many = Array.from({ length: 8 }, (_, i) => para(`Line number ${i + 1}`)).join('')
    const styles = graphicStyle('shr', 'draw:fill="none" draw:stroke="none" style:shrink-to-fit="true" draw:textarea-vertical-align="top"')
    const body = (style: string): string => `<draw:frame draw:style-name="${style}" svg:width="10cm" svg:height="2cm" svg:x="1cm" svg:y="1cm"><draw:text-box>${many}</draw:text-box></draw:frame>`
    const shrunk = await readPdf((await convert(buildOdp({ autoStyles: styles, slides: [{ body: body('shr') }] }))).bytes)
    expect(shrunk.pages[0].items[0].size).toBeLessThan(18)
    expect(shrunk.pages[0].text).toContain('Line number 8')
    const plain = await readPdf((await convert(buildOdp({ slides: [{ body: body('fr1') }] }))).bytes)
    expect(plain.pages[0].items[0].size).toBeCloseTo(18, 0)
    expect(plain.pages[0].text).toContain('Line number 8')
  })

  it('stops when cancelled and rejects packages that are not presentations', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(convert(buildOdp({ slides: [{ body: '' }] }), 'a.odp', { signal: ac.signal })).rejects.toThrow('Cancelled')
    await expect(convert(new TextEncoder().encode('not a zip'), 'bad.odp')).rejects.toThrow(/damaged or is not a valid Office file/)
  })
})

describe('odp: shapes, pictures, tables', () => {
  it('draws basic and custom shapes with fill, stroke and text; unsupported ones become rectangles with a warning', async () => {
    const styles =
      graphicStyle('red', 'draw:fill="solid" draw:fill-color="#ff0000" draw:stroke="solid" svg:stroke-color="#0000ff" svg:stroke-width="0.2cm"') +
      graphicStyle('nof', 'draw:fill="none" draw:stroke="solid" svg:stroke-color="#00ff00" svg:stroke-width="0.1cm"')
    const body =
      customShape('ellipse', 1, 1, 6, 3, 'red', 'Oval text') +
      customShape('ooxml-roundRect', 8, 1, 6, 3, 'red') +
      customShape('rectangle', 15, 1, 4, 3, 'nof') +
      customShape('mso-spt-weird', 1, 6, 4, 3, 'red', 'Weird') +
      `<draw:rect draw:style-name="red" svg:width="3cm" svg:height="2cm" svg:x="6cm" svg:y="6cm" draw:corner-radius="0.5cm"/>`
    const r = await convert(buildOdp({ autoStyles: styles, slides: [{ body }] }))
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/1 0 0 rg/)
    expect(c).toMatch(/0 0 1 RG/)
    expect(c).toMatch(/0 1 0 RG/)
    expect(c.match(/ c$/gm)?.length ?? 0).toBeGreaterThanOrEqual(8)
    const { pages } = await readPdf(r.bytes)
    const t = pages[0].items.find((i) => i.str === 'Oval text')!
    // left-aligned inside the ellipse's text area: 1cm + 14.64% of 6cm + 0.25cm padding
    expect(t.x).toBeCloseTo((1 + 0.1464 * 6 + 0.25) * CM, 0)
    expect(r.warnings.join('\n')).toMatch(/shape type “mso-spt-weird”.*rectangle/)
    expect(flattenText(pages)).toContain('Weird')
  })

  it('rotates shapes using draw:transform (rotate then translate) about their top-left corner', async () => {
    const styles = graphicStyle('red', 'draw:fill="solid" draw:fill-color="#ff0000" draw:stroke="none"')
    const shapeXml = `<draw:custom-shape draw:style-name="red" svg:width="3.527cm" svg:height="1.763cm" draw:transform="rotate (-0.785398163397449) translate (15.251cm 13.122cm)"><draw:enhanced-geometry draw:type="rectangle"/></draw:custom-shape>`
    const c = await contentOf((await convert(buildOdp({ autoStyles: styles, slides: [{ body: shapeXml }] }))).bytes)
    const m = /([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) ([\d.-]+) cm/.exec(c.split('cm')[0] + 'cm' + c.split('cm').slice(1, 2).join('cm'))
    void m
    const all = [...c.matchAll(/([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) ([\d.e-]+) cm/g)].map((x) => x.slice(1).map(Number))
    const rot = all.find((a) => Math.abs(a[0] - Math.SQRT1_2) < 1e-3 && Math.abs(a[1] - Math.SQRT1_2) < 1e-3)!
    expect(rot).toBeTruthy() // clockwise 45 degrees: cos = sin = 0.7071 with sin positive in y-down space
    expect(rot[2]).toBeCloseTo(-Math.SQRT1_2, 3)
    // the rotation pivot is the translated origin: a point at the pivot maps to itself
    const px = 15.251 * CM
    const py = 13.122 * CM
    expect(rot[0] * px + rot[2] * py + rot[4]).toBeCloseTo(px, 1)
    expect(rot[1] * px + rot[3] * py + rot[5]).toBeCloseTo(py, 1)
  })

  it('draws lines with arrow markers, polygons and svg paths', async () => {
    const styles = graphicStyle('ln', 'draw:stroke="solid" svg:stroke-color="#ff00ff" svg:stroke-width="0.1cm" draw:fill="none" draw:marker-end="Arrow" draw:marker-end-width="0.3cm"') + graphicStyle('poly', 'draw:fill="solid" draw:fill-color="#00ffff" draw:stroke="none"')
    const body =
      `<draw:line draw:style-name="ln" svg:x1="1cm" svg:y1="1cm" svg:x2="6cm" svg:y2="3cm"/>` +
      `<draw:polygon draw:style-name="poly" svg:x="8cm" svg:y="1cm" svg:width="4cm" svg:height="3cm" svg:viewBox="0 0 400 300" draw:points="0,300 200,0 400,300"/>` +
      `<draw:path draw:style-name="poly" svg:x="14cm" svg:y="1cm" svg:width="4cm" svg:height="3cm" svg:viewBox="0 0 400 300" svg:d="M 0 0 L 400 0 C 400 150 200 300 0 300 Z"/>`
    const r = await convert(buildOdp({ autoStyles: styles, slides: [{ body }] }))
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/28\.346\d* 28\.346\d* m\s+170\.07\d* 85\.03\d* l/)
    expect(c).toMatch(/1 0 1 RG/)
    expect(c.match(/^f$/gm)?.length ?? 0).toBeGreaterThanOrEqual(3) // polygon, path and the arrow head
    expect(c).toMatch(/0 1 1 rg/)
    expect(r.warnings).toEqual([])
  })

  it('embeds PNG pictures (from Pictures/ and inline base64) and reports unsupported formats', async () => {
    const png = makePng(20, 10, solid(0, 128, 255))
    const b64 = Buffer.from(png).toString('base64')
    const pic = (name: string, href: string, x: number): string => `<draw:frame draw:style-name="fr1" draw:name="${name}" svg:width="5cm" svg:height="2.5cm" svg:x="${x}cm" svg:y="1cm"><draw:image xlink:href="${href}" xlink:type="simple" xlink:show="embed" xlink:actuate="onLoad"/></draw:frame>`
    const body =
      pic('Pic A', 'Pictures/a.png', 1) +
      `<draw:frame draw:style-name="fr1" draw:name="Pic B" svg:width="5cm" svg:height="2.5cm" svg:x="8cm" svg:y="1cm"><draw:image><office:binary-data>${b64}</office:binary-data></draw:image></draw:frame>` +
      pic('Pic C', 'Pictures/c.gif', 15)
    const r = await convert(buildOdp({ slides: [{ body }], media: { 'Pictures/a.png': png, 'Pictures/c.gif': new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0, 0x3b]) } }))
    const { pages } = await readPdf(r.bytes)
    expect(pages[0].imageCount).toBe(2)
    expect(r.warnings.join('\n')).toMatch(/“Pic C” could not be drawn \(gif pictures cannot be embedded\)/)
    expect(pages[0].text).toContain('Picture (GIF)')
  })

  it('lays out tables with spans, fills and borders', async () => {
    const styles = `<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style><style:style style:name="ce1" style:family="table-cell"><style:table-cell-properties fo:background-color="#ffcc00" fo:border="0.5pt solid #000000" fo:padding="0.1cm"/></style:style><style:style style:name="ce2" style:family="table-cell"><style:table-cell-properties fo:padding="0.1cm"/></style:style>`
    const cell = (t: string, style = 'ce2', extra = ''): string => `<table:table-cell table:style-name="${style}"${extra}><text:p>${t}</text:p></table:table-cell>`
    const tbl = `<draw:frame draw:style-name="fr1" svg:width="12cm" svg:height="4cm" svg:x="2cm" svg:y="2cm"><table:table><table:table-column table:style-name="co1" table:number-columns-repeated="3"/><table:table-row>${cell('Name', 'ce1')}${cell('Qty', 'ce1')}${cell('Price', 'ce1')}</table:table-row><table:table-row>${cell('Apple')}${cell('3')}${cell('1.50')}</table:table-row><table:table-row>${cell('Merged', 'ce2', ' table:number-columns-spanned="2"')}<table:covered-table-cell/>${cell('9.99')}</table:table-row></table:table></draw:frame>`
    const r = await convert(buildOdp({ autoStyles: styles, slides: [{ body: tbl }] }))
    const { pages } = await readPdf(r.bytes)
    const it = (s: string) => pages[0].items.find((i) => i.str === s)!
    expect(it('Qty').x - it('Name').x).toBeCloseTo(4 * CM, 0)
    expect(it('Price').x - it('Qty').x).toBeCloseTo(4 * CM, 0)
    expect(it('9.99').x).toBeCloseTo(it('Price').x, 0)
    expect(it('Merged').x).toBeCloseTo(it('Name').x, 0)
    expect(it('Apple').y).toBeGreaterThan(it('Name').y + 10)
    const c = await contentOf(r.bytes)
    expect(c).toMatch(/1 0.8 0 rg/) // #ffcc00 header cells
    expect(c).toMatch(/0.5 w/)
  })

  it('shows placeholders and warnings for charts and embedded objects', async () => {
    const chart = `<draw:frame draw:style-name="fr1" draw:name="Sales" svg:width="8cm" svg:height="6cm" svg:x="1cm" svg:y="1cm"><draw:object xlink:href="./Object 1" xlink:type="simple"/></draw:frame>`
    const r = await convert(buildOdp({ slides: [{ body: chart }] }))
    expect(r.warnings.join('\n')).toMatch(/Embedded object “Sales” on slide 1 is not rendered/)
    expect(flattenText((await readPdf(r.bytes)).pages)).toContain('Embedded object')
  })
})

// ---------------------------------------------------------------------------------------------------
// Optional: compare with real LibreOffice output (skipped when LibreOffice is not installed).
// ---------------------------------------------------------------------------------------------------

const SOFFICE = 'C:\\Program Files\\LibreOffice\\program\\soffice.exe'

describe.skipIf(!existsSync(SOFFICE))('odp: real LibreOffice files', () => {
  it('converts an ODP written by LibreOffice (from a PPTX) to the same text and page size as the PPTX', async () => {
    const cell = (t: string): string => `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>${t}</a:t></a:r></a:p></a:txBody><a:tcPr/></a:tc>`
    const tbl = `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Table 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="457200" y="2500000"/><a:ext cx="3657600" cy="740000"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr/><a:tblGrid><a:gridCol w="1828800"/><a:gridCol w="1828800"/></a:tblGrid><a:tr h="370840">${cell('Name')}${cell('Qty')}</a:tr><a:tr h="370840">${cell('Apple')}${cell('3')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    const pptx = buildPptx({
      media: { 'ppt/media/image1.png': makePng(60, 30, (x, y) => [x * 4, y * 8, 200, 255]) },
      slides: [
        {
          shapes:
            titlePlaceholder(2, 'Round trip title') +
            bodyPlaceholder(3, ['First bullet', 'Second bullet']) +
            tbl +
            picture(13, 'rId5', 6500000, 4800000, 1800000, 900000) +
            shape(4, 'rect', 5080000, 5080000, 1270000, 635000, solidFill('FF0000'), 'Rot', ' rot="2700000"') +
            textBox(6, 3000000, 5080000, 1500000, 400000, ['Plain box']),
          rels: [{ id: 'rId5', type: 'image', target: '../media/image1.png' }]
        }
      ]
    })
    const tmp = mkdtempSync(join(tmpdir(), 'epdf-odp-'))
    try {
      mkdirSync(join(tmp, 'profile'))
      const src = join(tmp, 'in.pptx')
      writeFileSync(src, pptx)
      execFileSync(SOFFICE, ['--headless', '--convert-to', 'odp', '--outdir', tmp, `-env:UserInstallation=file:///${tmp.replace(/\\/g, '/')}/profile`, src], { timeout: 120000, stdio: 'ignore' })
      const odp = new Uint8Array(readFileSync(join(tmp, 'in.odp')))
      const a = await readPdf((await convert(pptx, 'in.pptx')).bytes)
      const conv = await convert(odp, 'in.odp')
      const b = await readPdf(conv.bytes)
      expect(conv.warnings).toEqual([])
      expect(b.pages[0].imageCount).toBe(1) // the picture; the table's preview image is not drawn
      expect(b.pages.length).toBe(a.pages.length)
      expect(b.pages[0].width).toBeCloseTo(a.pages[0].width, 0)
      expect(b.pages[0].height).toBeCloseTo(a.pages[0].height, 0)
      for (const s of ['Round trip title', 'First bullet', 'Second bullet', 'Rot', 'Plain box', 'Name', 'Qty', 'Apple']) expect(flattenText(b.pages)).toContain(s)
      const ta = a.pages[0].items.find((i) => i.str === 'Round trip title')!
      const tb = b.pages[0].items.find((i) => i.str === 'Round trip title')!
      expect(Math.abs(ta.x - tb.x)).toBeLessThan(8)
      expect(Math.abs(ta.y - tb.y)).toBeLessThan(8)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }, 180000)
})
