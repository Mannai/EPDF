import { PDFDict, PDFDocument, PDFName, PDFRef, PDFStream } from 'pdf-lib'
import { buildPageText } from '../../src/shared/pagetext'

/**
 * Shared checks for the text retrofit (features that write text into PDFs through the text engine): read the saved
 * output back in logical order with the page text model, including what widget / annotation appearances show.
 */

/** NFC + collapsed whitespace, the comparison normalisation of docs/page-text.md. */
export const norm = (s: string): string => s.normalize('NFC').replace(/\s+/g, ' ').trim()

/** Logical text of every page (page text model), lines joined with '\n'. */
export async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return pdf.getPages().map((_, i) => buildPageText(pdf, i).text)
}

/** The page text model of page `i`. */
export async function pageModel(bytes: Uint8Array, i = 0): Promise<ReturnType<typeof buildPageText>> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  return buildPageText(pdf, i)
}

/**
 * What the appearance streams of a document's annotations (form widgets, FreeText ...) show, read in logical order:
 * every annotation's normal appearance is drawn onto its page (what a reader paints), the page content is removed,
 * and the page text model reads the result. Returns one text per page.
 */
export async function appearanceTexts(bytes: Uint8Array): Promise<string[]> {
  return (await appearanceModels(bytes)).map((m) => m.text)
}

/** Like `appearanceTexts`, with the full page text model (geometry in display space) of every page. */
export async function appearanceModels(bytes: Uint8Array): Promise<ReturnType<typeof buildPageText>[]> {
  const flat = await PDFDocument.load(await appearanceOnlyPdf(bytes), { updateMetadata: false })
  return flat.getPages().map((_, i) => buildPageText(flat, i))
}

/** The document with every page's content replaced by what its annotations' normal appearances paint (flattened). */
export async function appearanceOnlyPdf(bytes: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(bytes, { updateMetadata: false })
  for (let i = 0; i < pdf.getPageCount(); i++) {
    const page = pdf.getPage(i)
    const annots = page.node.Annots()
    const ops: string[] = []
    const xobjects: Record<string, PDFRef> = {}
    for (let k = 0; k < (annots?.size() ?? 0); k++) {
      const a = annots!.lookup(k)
      if (!(a instanceof PDFDict)) continue
      const ap = a.lookupMaybe(PDFName.of('AP'), PDFDict)
      const n = ap?.get(PDFName.of('N'))
      // (check boxes and radio buttons have a dictionary of states here: no text to read)
      if (!(n instanceof PDFRef)) continue
      const s = pdf.context.lookup(n)
      if (!(s instanceof PDFStream)) continue
      const rect = (a.lookup(PDFName.of('Rect')) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((v) => v.asNumber())
      const bbox = (s.dict.lookup(PDFName.of('BBox')) as unknown as { asArray(): { asNumber(): number }[] }).asArray().map((v) => v.asNumber())
      const mat = s.dict.lookup(PDFName.of('Matrix')) as unknown as { asArray(): { asNumber(): number }[] } | undefined
      const m = mat ? mat.asArray().map((v) => v.asNumber()) : [1, 0, 0, 1, 0, 0]
      // Algorithm 8.1 (PDF 32000-1 12.5.5): map the transformed BBox onto Rect.
      const pts = [
        [bbox[0], bbox[1]],
        [bbox[2], bbox[1]],
        [bbox[0], bbox[3]],
        [bbox[2], bbox[3]]
      ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]])
      const x0 = Math.min(...pts.map((p) => p[0]))
      const y0 = Math.min(...pts.map((p) => p[1]))
      const x1 = Math.max(...pts.map((p) => p[0]))
      const y1 = Math.max(...pts.map((p) => p[1]))
      const [rx0, ry0, rx1, ry1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]
      const sx = (rx1 - rx0) / (x1 - x0 || 1)
      const sy = (ry1 - ry0) / (y1 - y0 || 1)
      const name = `ApX${k}`
      xobjects[name] = n
      ops.push(`q ${sx} 0 0 ${sy} ${rx0 - x0 * sx} ${ry0 - y0 * sy} cm /${name} Do Q`)
    }
    const content = pdf.context.register(pdf.context.stream(ops.join('\n')))
    page.node.set(PDFName.of('Contents'), content)
    page.node.set(PDFName.of('Resources'), pdf.context.obj({ XObject: xobjects }))
    page.node.delete(PDFName.of('Annots'))
  }
  return pdf.save({ updateFieldAppearances: false })
}

/** Every Type0 font object of a document. */
export function type0Fonts(pdf: PDFDocument): PDFDict[] {
  return [...pdf.context.enumerateIndirectObjects()]
    .map(([, o]) => o)
    .filter((o): o is PDFDict => o instanceof PDFDict && o.get(PDFName.of('Subtype'))?.toString() === '/Type0')
}

/** Annotations of page `n` (1-based) as PDF.js (legacy build, Node) reads them. */
export async function pdfjsAnnotations(bytes: Uint8Array, n = 1): Promise<Record<string, unknown>[]> {
  let pdfjs: typeof import('pdfjs-dist')
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs') // vitest
  } catch {
    // Playwright's transform turns `import()` into `require`, which cannot load this ES module: a native import
    const dynImport = new Function('s', 'return import(s)') as (s: string) => Promise<typeof import('pdfjs-dist')>
    pdfjs = await dynImport('pdfjs-dist/legacy/build/pdf.mjs')
  }
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0, disableFontFace: true })
  const doc = await task.promise
  try {
    return (await (await doc.getPage(n)).getAnnotations()) as Record<string, unknown>[]
  } finally {
    await task.destroy()
  }
}
