import { PDFDict, PDFName, PDFRef, PDFString, type PDFDocument, type PDFPage } from 'pdf-lib'
import { DestinationResolver, buildDestArray, normalizeTail } from '@shared/features/destinations'
import { asciiLiteral, pdfTextString, sanitizeTitle } from '@shared/features/pdftext'
import { addAnnotToPage, listLocated, locate, refId, removeLocated } from '../../markup/pdf/annots'
import { formatPdfDate, newAnnotName } from '../../markup/pdf/basics'
import { normalizeRect, type Rect } from '../../markup/pdf/geometry'
import { dictOf, formStream, fmt, getNumbers, numbers, num } from '../../markup/pdf/pdfobj'
import type { Quad } from '../../markup/pdf/quads'
import { ensureMinSize, rectOfQuads, scaleQuads, translateQuads } from './geometry'
import type { LinkBorder, LinkTargetInput } from './model'
import { readLink } from './read'
import { checkUrl } from './url'

/**
 * Creating, changing and deleting link annotations on a live pdf-lib document (call inside `editPdf`).
 * Links are real `/Subtype /Link` annotations: `/Rect` (and `/QuadPoints` for text that wraps), `/Border` +
 * `/BS` + `/C`, and either `/A` (a URI action) or `/Dest` (a page or named destination), with the print flag
 * set. A visible border also gets a small appearance stream so it shows up wherever annotation appearances are
 * painted (including Epdf's own viewer). Links from other software are edited in place: whatever this code does
 * not manage (JavaScript, GoToR, Launch actions, /AA, custom keys...) is preserved untouched.
 */

export class LinkError extends Error {}

const N = (s: string): PDFName => PDFName.of(s)
const FLAG_PRINT = 4

export interface NewLink {
  rect: Rect
  quads?: Quad[]
  target: LinkTargetInput
  border: LinkBorder
  contents?: string
}

function pageAt(pdf: PDFDocument, pageIndex: number): PDFPage {
  const p = pdf.getPages()[pageIndex]
  if (!p) throw new LinkError(`Page ${pageIndex + 1} does not exist.`)
  return p
}

const cleanRect = (r: Rect): Rect => {
  if (!r.every((v) => Number.isFinite(v))) throw new LinkError('The link area is not valid.')
  return ensureMinSize(normalizeRect(r))
}

// ---------------------------------------------------------------- target

/** Removes /Dest and /A and writes the new target. */
function writeTarget(pdf: PDFDocument, dict: PDFDict, target: LinkTargetInput): void {
  const ctx = pdf.context
  dict.delete(N('Dest'))
  dict.delete(N('A'))
  if (target.kind === 'uri') {
    const check = checkUrl(target.uri)
    if (!check.ok) throw new LinkError(check.reason)
    dict.set(N('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: asciiLiteral(check.url) }))
  } else if (target.kind === 'page') {
    const ref = pdf.getPages()[target.pageIndex]?.ref
    if (!ref) throw new LinkError(`Page ${target.pageIndex + 1} does not exist.`)
    dict.set(N('Dest'), buildDestArray(ctx, ref, normalizeTail(target.tail)))
  } else {
    const resolver = new DestinationResolver(pdf)
    if (!resolver.hasName(target.name)) throw new LinkError(`This document has no destination named “${target.name}”.`)
    dict.set(N('Dest'), resolver.isDictName(target.name) ? N(target.name) : isAscii(target.name) ? asciiLiteral(target.name) : pdfTextString(target.name))
  }
}

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s)

// ---------------------------------------------------------------- border and appearance

function writeBorder(pdf: PDFDocument, dict: PDFDict, b: LinkBorder): void {
  const ctx = pdf.context
  const w = Math.max(0, Math.round(b.width * 100) / 100)
  const dash = b.dashed && w > 0
  const border = [num(0), num(0), num(w)] as unknown[]
  if (dash) border.push(numbers(ctx, [3, 3]))
  dict.set(N('Border'), ctx.obj(border as never))
  const bs = dictOf(ctx, { Type: 'Border', W: w, S: dash ? 'D' : 'S', D: dash ? [3, 3] : undefined })
  dict.set(N('BS'), bs)
  if (b.color) dict.set(N('C'), numbers(ctx, b.color.map((v) => Math.min(1, Math.max(0, v)))))
  else dict.delete(N('C'))
}

/** The outline appearance of a visible border: one stroked rectangle per quad (or for the rect). */
function borderAppearance(pdf: PDFDocument, rect: Rect, quads: readonly Quad[], b: LinkBorder): PDFRef {
  const ctx = pdf.context
  const boxes: Rect[] = quads.length ? quads.map((q) => rectOfQuads([q])!) : [rect]
  const c = b.color ?? [0, 0, 0]
  const half = b.width / 2
  let ops = `q ${fmt(b.width)} w ${c.map(fmt).join(' ')} RG\n`
  if (b.dashed) ops += '[3 3] 0 d\n'
  for (const r of boxes) {
    const w = r[2] - r[0] - b.width
    const h = r[3] - r[1] - b.width
    if (w > 0 && h > 0) ops += `${fmt(r[0] + half)} ${fmt(r[1] + half)} ${fmt(w)} ${fmt(h)} re S\n`
  }
  ops += 'Q'
  return ctx.register(formStream(ctx, ops, rect, {}))
}

function writeAppearance(pdf: PDFDocument, dict: PDFDict, rect: Rect, quads: readonly Quad[], b: LinkBorder): void {
  const old = dict.get(N('AP'))
  if (b.width > 0) {
    const ref = borderAppearance(pdf, rect, quads, b)
    dict.set(N('AP'), pdf.context.obj({ N: ref }))
  } else if (old !== undefined) dict.delete(N('AP'))
}

// ---------------------------------------------------------------- create

function createOne(pdf: PDFDocument, pageIndex: number, spec: NewLink): string {
  const page = pageAt(pdf, pageIndex)
  const ctx = pdf.context
  const quads = spec.quads ?? []
  const rect = cleanRect(quads.length ? (rectOfQuads(quads) ?? spec.rect) : spec.rect)
  const now = PDFString.of(formatPdfDate(new Date()))
  const dict = dictOf(ctx, { Type: 'Annot', Subtype: 'Link', Rect: rect.map((v) => v), F: FLAG_PRINT, P: page.ref, NM: PDFString.of(newAnnotName()), M: now })
  if (quads.length) dict.set(N('QuadPoints'), numbers(ctx, quads.flat()))
  const contents = sanitizeTitle(spec.contents ?? '')
  if (contents) dict.set(N('Contents'), pdfTextString(contents))
  writeTarget(pdf, dict, spec.target)
  writeBorder(pdf, dict, spec.border)
  writeAppearance(pdf, dict, rect, quads, spec.border)
  const ref = ctx.register(dict)
  addAnnotToPage(pdf, page, ref)
  return refId(ref)
}

/** Adds one link; returns its id. */
export function addLink(pdf: PDFDocument, pageIndex: number, spec: NewLink): string {
  return createOne(pdf, pageIndex, spec)
}

/** Adds several links in one go (auto-detected URLs, links from a text selection on several pages); returns their ids. */
export function addLinks(pdf: PDFDocument, items: { pageIndex: number; spec: NewLink }[]): string[] {
  if (items.length === 0) throw new LinkError('There are no links to add.')
  return items.map((i) => createOne(pdf, i.pageIndex, i.spec))
}

// ---------------------------------------------------------------- change

export interface LinkPatch {
  rect?: Rect
  quads?: Quad[]
  target?: LinkTargetInput
  border?: LinkBorder
  contents?: string
}

function need(pdf: PDFDocument, id: string): NonNullable<ReturnType<typeof locate>> {
  const loc = locate(pdf, id)
  if (!loc || (loc.dict.lookup(N('Subtype')) as PDFName | undefined)?.decodeText() !== 'Link') throw new LinkError('That link no longer exists.')
  return loc
}

export function updateLink(pdf: PDFDocument, id: string, patch: LinkPatch): void {
  const loc = need(pdf, id)
  const info = readLink(loc, new DestinationResolver(pdf))!
  const dict = loc.dict
  let rect = info.rect
  let quads = info.quads
  if (patch.quads) quads = patch.quads
  if (patch.rect) {
    rect = cleanRect(patch.rect)
    if (!patch.quads && quads.length) quads = scaleQuads(quads, info.rect, rect)
  } else if (patch.quads) rect = cleanRect(rectOfQuads(patch.quads) ?? rect)
  if (patch.rect || patch.quads) {
    dict.set(N('Rect'), numbers(pdf.context, rect))
    if (quads.length) dict.set(N('QuadPoints'), numbers(pdf.context, quads.flat()))
    else dict.delete(N('QuadPoints'))
  }
  if (patch.target) writeTarget(pdf, dict, patch.target)
  const border = patch.border ?? info.border
  if (patch.border) writeBorder(pdf, dict, patch.border)
  // Our own border appearance follows the rect; a foreign appearance is only replaced when the border was changed on purpose.
  if (patch.border || ((patch.rect || patch.quads) && (info.ours || !dict.has(N('AP'))))) writeAppearance(pdf, dict, rect, quads, border)
  if (patch.contents !== undefined) {
    const c = sanitizeTitle(patch.contents)
    if (c) dict.set(N('Contents'), pdfTextString(c))
    else dict.delete(N('Contents'))
  }
  dict.set(N('M'), PDFString.of(formatPdfDate(new Date())))
}

export function moveLink(pdf: PDFDocument, id: string, dx: number, dy: number): void {
  const loc = need(pdf, id)
  const info = readLink(loc, new DestinationResolver(pdf))!
  updateLink(pdf, id, {
    rect: [info.rect[0] + dx, info.rect[1] + dy, info.rect[2] + dx, info.rect[3] + dy],
    quads: info.quads.length ? translateQuads(info.quads, dx, dy) : undefined
  })
}

export function resizeLink(pdf: PDFDocument, id: string, rect: Rect): void {
  updateLink(pdf, id, { rect })
}

export function deleteLink(pdf: PDFDocument, id: string): void {
  const loc = need(pdf, id)
  removeLocated(pdf, [loc])
}

/** Deletes every link annotation of one page (or of the whole document). Returns how many. */
export function removeAllLinks(pdf: PDFDocument, pageIndex?: number): number {
  const all = listLocated(pdf).filter((l) => {
    if (pageIndex !== undefined && l.pageIndex !== pageIndex) return false
    try {
      return (l.dict.lookup(N('Subtype')) as PDFName | undefined)?.decodeText() === 'Link'
    } catch {
      return false
    }
  })
  removeLocated(pdf, all)
  return all.length
}

/** Rect of a link straight from its dictionary (used by tests and by callers without a full read). */
export function linkRect(pdf: PDFDocument, id: string): Rect | null {
  const loc = locate(pdf, id)
  const r = loc ? getNumbers(loc.dict, 'Rect') : undefined
  return r && r.length >= 4 ? normalizeRect(r) : null
}

