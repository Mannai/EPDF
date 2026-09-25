import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFStream, StandardFonts, degrees, rgb } from 'pdf-lib'
import { listLocated } from '../../src/renderer/src/features/markup/pdf/annots'
import { getDict, get, getNumbers } from '../../src/renderer/src/features/markup/pdf/pdfobj'

export interface MakeOptions {
  rotation?: number
  cropBox?: [number, number, number, number]
  pages?: number
  /** Put the first page's /Annots in an indirect array holding an existing Link annotation. */
  indirectAnnots?: boolean
  /** Put a direct (inline) Link annotation in the first page's /Annots. */
  directAnnots?: boolean
}

/** A small PDF: `pages` Letter pages with a text line each, optionally rotated/cropped and with existing annotations. */
export async function makePdf(o: MakeOptions = {}): Promise<PDFDocument> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  for (let i = 0; i < (o.pages ?? 1); i++) {
    const p = pdf.addPage([612, 792])
    p.drawText(`Epdf markup fixture page ${i + 1}`, { x: 72, y: 700, size: 20, font, color: rgb(0, 0, 0) })
    if (o.rotation) p.setRotation(degrees(o.rotation))
    if (o.cropBox) p.setCropBox(o.cropBox[0], o.cropBox[1], o.cropBox[2] - o.cropBox[0], o.cropBox[3] - o.cropBox[1])
  }
  const first = pdf.getPage(0)
  if (o.indirectAnnots) {
    const link = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30], Border: [0, 0, 0] }))
    const arr = pdf.context.register(pdf.context.obj([link]))
    first.node.set(PDFName.of('Annots'), arr)
  }
  if (o.directAnnots) {
    first.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [10, 10, 60, 30] })]))
  }
  return pdf
}

export const reload = async (pdf: PDFDocument): Promise<PDFDocument> => PDFDocument.load(await pdf.save())

/** All annotation dicts of a page in the reloaded document. */
export function annotsOf(pdf: PDFDocument, pageIndex = 0): PDFDict[] {
  return listLocated(pdf)
    .filter((l) => l.pageIndex === pageIndex)
    .map((l) => l.dict)
}

export const subtypes = (pdf: PDFDocument, pageIndex = 0): string[] =>
  annotsOf(pdf, pageIndex).map((d) => (d.get(PDFName.of('Subtype')) as PDFName).decodeText())

export function apStream(dict: PDFDict): PDFRawStream {
  const ap = getDict(dict, 'AP')
  if (!ap) throw new Error('no /AP')
  const n = get(ap, 'N')
  if (!(n instanceof PDFRawStream)) throw new Error('/AP /N is not a stream')
  return n
}

export const apOps = (dict: PDFDict): string => new TextDecoder().decode(apStream(dict).getContents())

export const apBBox = (dict: PDFDict): number[] => getNumbers(apStream(dict).dict, 'BBox')!
export const apMatrix = (dict: PDFDict): number[] | undefined => getNumbers(apStream(dict).dict, 'Matrix')
export const apResources = (dict: PDFDict): PDFDict => getDict(apStream(dict).dict, 'Resources')!

export const nameOf = (d: PDFDict, k: string): string | undefined => (d.get(PDFName.of(k)) as PDFName | undefined)?.decodeText()

export const isStream = (o: unknown): boolean => o instanceof PDFStream

/**
 * Strict structural validation of every annotation we can list: a stand-in for "does it open elsewhere"
 * (we cannot run Acrobat in tests). Returns human-readable problems; an empty list means valid.
 */
export function validateAnnotations(pdf: PDFDocument): string[] {
  const problems: string[] = []
  const ctx = pdf.context
  const pageRefs = new Set(pdf.getPages().map((p) => p.ref.toString()))
  for (const loc of listLocated(pdf)) {
    const d = loc.dict
    const tag = `${loc.id} (${nameOf(d, 'Subtype')})`
    if (nameOf(d, 'Type') !== 'Annot') problems.push(`${tag}: /Type is not /Annot`)
    const rect = getNumbers(d, 'Rect')
    if (!rect || rect.length !== 4 || !rect.every(Number.isFinite)) problems.push(`${tag}: bad /Rect`)
    else if (rect[0] > rect[2] || rect[1] > rect[3]) problems.push(`${tag}: /Rect not normalized`)
    const p = d.get(PDFName.of('P'))
    if (p !== undefined && !(p instanceof PDFRef && pageRefs.has(p.toString()))) problems.push(`${tag}: /P is not a page`)
    const ap = getDict(d, 'AP')
    if (ap) {
      const n = get(ap, 'N')
      if (!(n instanceof PDFStream)) {
        problems.push(`${tag}: /AP /N is not a stream`)
        continue
      }
      if (nameOf(n.dict, 'Subtype') !== 'Form') problems.push(`${tag}: AP is not a Form XObject`)
      const bbox = getNumbers(n.dict, 'BBox')
      if (!bbox || bbox.length !== 4 || !(bbox[2] > bbox[0]) || !(bbox[3] > bbox[1])) problems.push(`${tag}: bad AP /BBox ${bbox}`)
      const matrix = getNumbers(n.dict, 'Matrix')
      if (matrix && matrix.length !== 6) problems.push(`${tag}: bad AP /Matrix`)
      const res = getDict(n.dict, 'Resources')
      if (!res) problems.push(`${tag}: AP has no /Resources`)
      else {
        const fonts = getDict(res, 'Font')
        if (fonts) {
          for (const [, v] of fonts.entries()) {
            const f = v instanceof PDFRef ? ctx.lookup(v) : v
            if (!(f instanceof PDFDict) || nameOf(f, 'Type') !== 'Font') problems.push(`${tag}: font resource does not resolve to a font dict`)
          }
        }
        const xo = getDict(res, 'XObject')
        if (xo) for (const [, v] of xo.entries()) if (!(v instanceof PDFRef && ctx.lookup(v) instanceof PDFStream)) problems.push(`${tag}: XObject resource dangling`)
      }
      const contents = new TextDecoder().decode((n as PDFRawStream).getContents())
      // Balanced graphics state and text objects.
      const q = (contents.match(/(^|\s)q(\s|$)/g) ?? []).length
      const Q = (contents.match(/(^|\s)Q(\s|$)/g) ?? []).length
      if (q !== Q) problems.push(`${tag}: unbalanced q/Q (${q}/${Q})`)
      const bt = (contents.match(/(^|\s)BT(\s|$)/g) ?? []).length
      const et = (contents.match(/(^|\s)ET(\s|$)/g) ?? []).length
      if (bt !== et) problems.push(`${tag}: unbalanced BT/ET`)
      if (/NaN|Infinity|undefined/.test(contents)) problems.push(`${tag}: invalid number in content stream`)
    }
    const irt = d.get(PDFName.of('IRT'))
    if (irt !== undefined && !(irt instanceof PDFRef && ctx.lookup(irt) instanceof PDFDict)) problems.push(`${tag}: /IRT dangling`)
  }
  return problems
}

export const isArray = (o: unknown): o is PDFArray => o instanceof PDFArray
