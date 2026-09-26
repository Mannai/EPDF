import { PDFArray, PDFDict, PDFName, PDFNumber, type PDFDocument } from 'pdf-lib'
import { DestinationResolver } from '@shared/features/destinations'
import { readPdfText } from '@shared/features/pdftext'
import { isOurName } from '../../markup/pdf/basics'
import { listLocated, type Located } from '../../markup/pdf/annots'
import { normalizeRect } from '../../markup/pdf/geometry'
import { get, getDict, getName, getNumber, getNumbers, getString } from '../../markup/pdf/pdfobj'
import { splitQuads } from '../../markup/pdf/quads'
import type { LinkBorder, LinkInfo } from './model'

/** Reads a document's link annotations (including ones written by other software). Never throws on a bad one. */

export function readBorder(d: PDFDict): LinkBorder {
  const bs = getDict(d, 'BS')
  let width = 1 // the PDF default when neither /BS nor /Border is present
  let dashed = false
  if (bs) {
    width = getNumber(bs, 'W') ?? 1
    dashed = getName(bs, 'S') === 'D'
  } else {
    const border = get(d, 'Border')
    if (border instanceof PDFArray && border.size() >= 3) {
      const w = border.lookup(2)
      if (w instanceof PDFNumber) width = w.asNumber()
      const dash = border.size() >= 4 ? border.lookup(3) : undefined
      dashed = dash instanceof PDFArray && dash.size() > 0
    }
  }
  const c = getNumbers(d, 'C')
  let color: LinkBorder['color'] = null
  if (c && c.length === 3) color = [clamp01(c[0]), clamp01(c[1]), clamp01(c[2])]
  else if (c && c.length === 1) color = [clamp01(c[0]), clamp01(c[0]), clamp01(c[0])]
  else if (c && c.length === 4) {
    const k = 1 - clamp01(c[3])
    color = [(1 - clamp01(c[0])) * k, (1 - clamp01(c[1])) * k, (1 - clamp01(c[2])) * k]
  }
  return { width: Math.max(0, Number.isFinite(width) ? width : 1), dashed, color }
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0)

export function readLink(loc: Located, resolver: DestinationResolver): LinkInfo | null {
  const d = loc.dict
  if (getName(d, 'Subtype') !== 'Link') return null
  const rectRaw = getNumbers(d, 'Rect')
  if (!rectRaw || rectRaw.length < 4) return null
  return {
    id: loc.id,
    pageIndex: loc.pageIndex,
    rect: normalizeRect(rectRaw),
    quads: splitQuads(getNumbers(d, 'QuadPoints')),
    target: resolver.resolveItem(d),
    border: readBorder(d),
    flags: getNumber(d, 'F') ?? 0,
    contents: readPdfText(d.lookup(PDFName.of('Contents'))) ?? '',
    ours: isOurName(getString(d, 'NM'))
  }
}

export function readLinks(pdf: PDFDocument): LinkInfo[] {
  const resolver = new DestinationResolver(pdf)
  const out: LinkInfo[] = []
  for (const loc of listLocated(pdf)) {
    try {
      const l = readLink(loc, resolver)
      if (l) out.push(l)
    } catch {
      /* a malformed annotation must not hide the others */
    }
  }
  return out
}
