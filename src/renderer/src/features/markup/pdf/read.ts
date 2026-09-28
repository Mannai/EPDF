import { PDFDict, PDFName, PDFRef, PDFStream, type PDFDocument } from 'pdf-lib'
import { isOurName, clampOpacity, parsePdfDate } from './basics'
import { listLocated, refId, type Located } from './annots'
import { normalizeRect, type Rect } from './geometry'
import { isListedSubtype, type AnnotInfo } from './model'
import { get, getDict, getName, getNames, getNumber, getNumberArrays, getNumbers, getString } from './pdfobj'
import { splitQuads } from './quads'

/** Parses a FreeText /DA string: text colour and font size (defaults: black, 12). */
export function parseDA(da: string | undefined): { color: number[]; size: number } {
  let color: number[] = [0, 0, 0]
  let size = 12
  if (da) {
    const tf = /\/\S+\s+([\d.]+)\s+Tf/.exec(da)
    if (tf && +tf[1] > 0) size = +tf[1]
    const c = /((?:[\d.]+\s+){1,4})(rg|g|k)\b/.exec(da)
    if (c) {
      const comps = c[1].trim().split(/\s+/).map(Number)
      if (comps.every(Number.isFinite) && comps.length === { rg: 3, g: 1, k: 4 }[c[2] as 'rg' | 'g' | 'k']) color = comps
    }
  }
  return { color, size }
}

/** Plain text of an XHTML/XML rich-text string (/RC). */
export function stripRichText(rc: string): string {
  return rc
    .replace(/<\/(p|div|br)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function readAnnotation(loc: Located): AnnotInfo | null {
  const d = loc.dict
  const subtype = getName(d, 'Subtype')
  if (!subtype || !isListedSubtype(subtype)) return null
  const rectRaw = getNumbers(d, 'Rect')
  if (!rectRaw || rectRaw.length < 4) return null
  const rect: Rect = normalizeRect(rectRaw)

  let contents = getString(d, 'Contents') ?? ''
  if (!contents) {
    const rc = getString(d, 'RC')
    if (rc) contents = stripRichText(rc)
  }

  const bs = getDict(d, 'BS')
  const border = getNumbers(d, 'Border')
  let borderWidth = bs ? (getNumber(bs, 'W') ?? 1) : border && border.length >= 3 ? border[2] : 1
  let dashed = false
  if (bs) dashed = getName(bs, 'S') === 'D'
  else if (border && border.length >= 4) dashed = true
  const be = getDict(d, 'BE')
  const irt = d.get(PDFName.of('IRT'))
  const ap = getDict(d, 'AP')
  const normal = ap ? get(ap, 'N') : undefined
  const le = getNames(d, 'LE') ?? []

  let color: number[] | null = getNumbers(d, 'C') ?? null
  let fill: number[] | null = getNumbers(d, 'IC') ?? null
  let fontSize = 12
  if (subtype === 'FreeText') {
    const da = parseDA(getString(d, 'DA'))
    fill = color && color.length ? color : null
    color = da.color
    fontSize = da.size
    if (!bs && !border) borderWidth = 0
  }
  if (color && ![1, 3, 4].includes(color.length)) color = null
  if (fill && ![1, 3, 4].includes(fill.length)) fill = null

  const nm = getString(d, 'NM') ?? ''
  const rt = getName(d, 'RT')
  return {
    id: loc.id,
    pageIndex: loc.pageIndex,
    order: loc.index,
    subtype,
    rect,
    contents,
    author: getString(d, 'T') ?? '',
    subject: getString(d, 'Subj') ?? '',
    modified: parsePdfDate(getString(d, 'M')),
    created: parsePdfDate(getString(d, 'CreationDate')),
    name: nm,
    color,
    fill,
    opacity: clampOpacity(getNumber(d, 'CA') ?? 1),
    flags: getNumber(d, 'F') ?? 0,
    quads: splitQuads(getNumbers(d, 'QuadPoints')),
    ink: getNumberArrays(d, 'InkList') ?? [],
    line: getNumbers(d, 'L') ?? null,
    lineEnds: [le[0] ?? 'None', le[1] ?? 'None'],
    borderWidth,
    dashed,
    fontSize,
    iconName: getName(d, 'Name') ?? '',
    irt: irt instanceof PDFRef ? refId(irt) : null,
    replyType: rt === 'Group' ? 'Group' : 'R',
    state: getString(d, 'State') ?? getName(d, 'State') ?? null,
    stateModel: getString(d, 'StateModel') ?? getName(d, 'StateModel') ?? null,
    hasAppearance: normal instanceof PDFStream || normal instanceof PDFDict,
    complex: (!!be && getName(be, 'S') === 'C') || (subtype === 'Line' && le.some((s) => !['None', 'OpenArrow', 'ClosedArrow'].includes(s))),
    ours: isOurName(nm),
    fillSign: fillKindOf(getName(d, 'EpdfFill'))
  }
}

const fillKindOf = (n: string | undefined): AnnotInfo['fillSign'] => (n === 'Mark' || n === 'Text' || n === 'Signature' ? n : null)

/** All listed annotations of the document. Pages or entries that cannot be parsed are skipped, never fatal. */
export function readAnnotations(pdf: PDFDocument): AnnotInfo[] {
  const out: AnnotInfo[] = []
  for (const loc of listLocated(pdf)) {
    try {
      const a = readAnnotation(loc)
      if (a) out.push(a)
    } catch {
      /* a malformed annotation must not hide the others */
    }
  }
  return out
}
