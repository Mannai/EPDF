import { PDFDict, PDFName, PDFNumber, PDFRef, PDFString, type PDFDocument, type PDFPage } from 'pdf-lib'
import { addAnnotToPage, descendantIds, listLocated, locate, refId, removeLocated, type Located } from './annots'
import {
  apRotation,
  buildImageStamp,
  colorOp,
  freeTextNeededHeight,
  infoOfDict,
  installAppearance,
  NOTE_SIZE,
  regenerateAppearance,
  stampSize
} from './appearance'
import { clampOpacity, formatPdfDate, newAnnotName, sanitizeColor, isOurName, type Color } from './basics'
import {
  clampCenter,
  geomOfPage,
  normalizeRect,
  normRotation,
  rectHeight,
  rectWidth,
  uprightRectAt,
  uprightSize,
  type Pt,
  type Rect
} from './geometry'
import { capabilities, type ReviewState } from './model'
import { dictOf, getDict, getName, getNumberArrays, getNumbers, numbers, setNumbers, text, type Literal } from './pdfobj'
import { stampByName } from './stamps'

/**
 * Everything that changes annotations, as functions of a loaded pdf-lib document (the `editPdf` callback
 * argument). They only write annotation dictionaries, appearance streams and the /Annots arrays; nothing
 * else in the file is touched. Each returns the id of what it created so the UI can select it.
 */

export interface Who {
  author: string
  now?: Date
}

const FLAG_PRINT = 4
const FLAG_REPLY = 4 | 8 | 16 // Print, NoZoom, NoRotate: what Acrobat writes for replies/state changes

function page(pdf: PDFDocument, pageIndex: number): PDFPage {
  const p = pdf.getPages()[pageIndex]
  if (!p) throw new Error(`Page ${pageIndex + 1} does not exist.`)
  return p
}

interface BaseOptions extends Who {
  subtype: string
  rect: Rect
  contents?: string
  subject?: string
  color?: Color | null
  opacity?: number
  flags?: number
  extra?: Record<string, unknown>
}

/** Creates the annotation dictionary (without appearance), registers it and appends it to the page. */
function createAnnot(pdf: PDFDocument, pageIndex: number, o: BaseOptions): { dict: PDFDict; ref: PDFRef } {
  const p = page(pdf, pageIndex)
  const ctx = pdf.context
  const date = PDFString.of(formatPdfDate(o.now ?? new Date()))
  const opacity = o.opacity === undefined ? 1 : clampOpacity(o.opacity)
  const dict = dictOf(ctx, {
    Type: 'Annot',
    Subtype: o.subtype,
    Rect: o.rect.map((v) => v) as number[],
    F: o.flags ?? FLAG_PRINT,
    P: p.ref,
    T: text(o.author),
    M: date,
    CreationDate: date,
    NM: PDFString.of(newAnnotName()),
    Contents: text(o.contents ?? ''),
    Subj: o.subject ? text(o.subject) : undefined,
    C: o.color ? sanitizeColor(o.color) : undefined,
    CA: opacity < 1 ? opacity : undefined,
    ...((o.extra ?? {}) as Record<string, Literal>)
  })
  const ref = ctx.register(dict)
  addAnnotToPage(pdf, p, ref)
  return { dict, ref }
}

// ---------------------------------------------------------------- text markup

export interface TextMarkupOptions extends Who {
  subtype: 'Highlight' | 'Underline' | 'StrikeOut' | 'Squiggly'
  quads: number[][]
  color: Color
  opacity: number
  contents?: string
}

export async function addTextMarkup(pdf: PDFDocument, pageIndex: number, o: TextMarkupOptions): Promise<string> {
  if (o.quads.length === 0) throw new Error('Nothing is selected.')
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    rect: [0, 0, 0, 0],
    extra: { QuadPoints: numbers(pdf.context, o.quads.flat()) }
  })
  await regenerateAppearance(pdf, dict, geomOfPage(page(pdf, pageIndex)).rotation)
  return refId(ref)
}

// ---------------------------------------------------------------- ink

export interface InkOptions extends Who {
  /** Strokes in PDF space, already smoothed. */
  strokes: Pt[][]
  color: Color
  width: number
  opacity: number
}

export async function addInk(pdf: PDFDocument, pageIndex: number, o: InkOptions): Promise<string> {
  const strokes = o.strokes.filter((s) => s.length >= 2)
  if (strokes.length === 0) throw new Error('Nothing was drawn.')
  const ctx = pdf.context
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'Ink',
    rect: [0, 0, 0, 0],
    extra: {
      InkList: strokes.map((s) => numbers(ctx, s.flat())),
      BS: { Type: 'Border', W: Math.max(0.25, o.width), S: 'S' }
    }
  })
  await regenerateAppearance(pdf, dict, 0)
  return refId(ref)
}

// ---------------------------------------------------------------- shapes

export interface ShapeOptions extends Who {
  kind: 'Square' | 'Circle'
  /** PDF-space rect including the stroke. */
  rect: Rect
  color: Color
  fill: Color | null
  width: number
  opacity: number
  dashed: boolean
}

export async function addShape(pdf: PDFDocument, pageIndex: number, o: ShapeOptions): Promise<string> {
  const w = Math.max(0, o.width)
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: o.kind,
    rect: normalizeRect(o.rect),
    extra: {
      IC: o.fill ? sanitizeColor(o.fill) : undefined,
      BS: { Type: 'Border', W: w, S: o.dashed ? 'D' : 'S', D: o.dashed ? [3, 2] : undefined }
    }
  })
  await regenerateAppearance(pdf, dict, 0)
  return refId(ref)
}

export interface LineOptions extends Who {
  from: Pt
  to: Pt
  arrow: boolean
  color: Color
  width: number
  opacity: number
  dashed: boolean
}

export async function addLine(pdf: PDFDocument, pageIndex: number, o: LineOptions): Promise<string> {
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'Line',
    rect: [0, 0, 0, 0],
    extra: {
      L: [o.from[0], o.from[1], o.to[0], o.to[1]],
      LE: ['None', o.arrow ? 'OpenArrow' : 'None'],
      IT: o.arrow ? 'LineArrow' : undefined,
      BS: { Type: 'Border', W: Math.max(0.25, o.width), S: o.dashed ? 'D' : 'S', D: o.dashed ? [3, 2] : undefined }
    }
  })
  await regenerateAppearance(pdf, dict, 0)
  return refId(ref)
}

// ---------------------------------------------------------------- sticky note

export interface NoteOptions extends Who {
  /** PDF-space point the icon is centred on (kept inside the page). */
  center: Pt
  contents: string
  color: Color
  icon: 'Note' | 'Comment'
}

export async function addNote(pdf: PDFDocument, pageIndex: number, o: NoteOptions): Promise<string> {
  const g = geomOfPage(page(pdf, pageIndex))
  const rect = placeRect(g, o.center, NOTE_SIZE, NOTE_SIZE)
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'Text',
    rect,
    extra: { Name: o.icon, Open: false }
  })
  await regenerateAppearance(pdf, dict, g.rotation)
  return refId(ref)
}

/** An upright `w × h` box centred (and clamped) on `center`, as a PDF-space rect for this page's rotation. */
export function placeRect(g: ReturnType<typeof geomOfPage>, center: Pt, w: number, h: number): Rect {
  const r = normRotation(g.rotation)
  const [pw, ph] = r === 90 || r === 270 ? [h, w] : [w, h]
  const [cx, cy] = clampCenter(g, center[0], center[1], pw, ph)
  return uprightRectAt(cx, cy, w, h, r)
}

// ---------------------------------------------------------------- free text

export interface FreeTextOptions extends Who {
  /** PDF-space rect the user dragged. Grown downwards if the text does not fit. */
  rect: Rect
  text: string
  fontSize: number
  color: Color
  fill: Color | null
  borderWidth: number
  dashed?: boolean
  opacity?: number
}

/** Grows `rect` by `extra` points towards the bottom of the *displayed* page. */
export function growRectDown(rect: Rect, rotation: number, extra: number): Rect {
  if (extra <= 0) return rect
  switch (normRotation(rotation)) {
    case 90:
      return [rect[0], rect[1], rect[2] + extra, rect[3]]
    case 180:
      return [rect[0], rect[1], rect[2], rect[3] + extra]
    case 270:
      return [rect[0] - extra, rect[1], rect[2], rect[3]]
    default:
      return [rect[0], rect[1] - extra, rect[2], rect[3]]
  }
}

export function daString(color: Color, size: number): string {
  return `${colorOp(color, false)} /Helv ${Math.round(size * 100) / 100} Tf`
}

export async function addFreeText(pdf: PDFDocument, pageIndex: number, o: FreeTextOptions): Promise<string> {
  const g = geomOfPage(page(pdf, pageIndex))
  let rect = normalizeRect(o.rect)
  const [w, h] = uprightSize(rect, g.rotation)
  rect = growRectDown(rect, g.rotation, (await freeTextNeededHeight(pdf, o.text, w, o.fontSize, o.borderWidth)) - h)
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'FreeText',
    rect,
    contents: o.text,
    color: o.fill, // /C = fill (Acrobat convention); the text colour lives in /DA
    extra: {
      DA: PDFString.of(daString(o.color, o.fontSize)),
      Q: 0,
      BS: { Type: 'Border', W: Math.max(0, o.borderWidth), S: o.dashed ? 'D' : 'S', D: o.dashed ? [3, 2] : undefined }
    }
  })
  await regenerateAppearance(pdf, dict, g.rotation)
  return refId(ref)
}

// ---------------------------------------------------------------- stamps

export interface StampOptions extends Who {
  name: string
  center: Pt
  opacity?: number
}

export async function addStamp(pdf: PDFDocument, pageIndex: number, o: StampOptions): Promise<string> {
  const def = stampByName(o.name)
  if (!def) throw new Error(`Unknown stamp “${o.name}”.`)
  const g = geomOfPage(page(pdf, pageIndex))
  const [w, h] = await stampSize(pdf, def)
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'Stamp',
    rect: placeRect(g, o.center, w, h),
    contents: def.label,
    subject: def.label,
    extra: { Name: def.name }
  })
  await regenerateAppearance(pdf, dict, g.rotation)
  return refId(ref)
}

export interface ImageStampOptions extends Who {
  kind: 'png' | 'jpg'
  bytes: Uint8Array
  /** Shown as the stamp's text (usually the file name). */
  label: string
  center: Pt
  /** Longest side of the stamp in points. */
  maxSize?: number
  opacity?: number
}

export async function addImageStamp(pdf: PDFDocument, pageIndex: number, o: ImageStampOptions): Promise<string> {
  const image = o.kind === 'png' ? await pdf.embedPng(o.bytes) : await pdf.embedJpg(o.bytes)
  const g = geomOfPage(page(pdf, pageIndex))
  const max = o.maxSize ?? 200
  const k = Math.min(max / image.width, max / image.height, 1 * (max / Math.max(image.width, image.height)))
  const w = Math.max(8, image.width * k)
  const h = Math.max(8, image.height * k)
  const { dict, ref } = createAnnot(pdf, pageIndex, {
    ...o,
    subtype: 'Stamp',
    rect: placeRect(g, o.center, w, h),
    contents: o.label,
    extra: { Name: 'Image' }
  })
  const info = infoOfDict(dict)!
  installAppearance(pdf, dict, buildImageStamp(info, image.ref, g.rotation))
  return refId(ref)
}

// ---------------------------------------------------------------- replies and review state

function pageOf(loc: Located): number {
  return loc.pageIndex
}

function replyBase(pdf: PDFDocument, parent: Located, o: Who, extra: Record<string, unknown>, contents: string): string {
  const info = infoOfDict(parent.dict)
  const r = info ? info.rect : ([0, 0, NOTE_SIZE, NOTE_SIZE] as Rect)
  const rect: Rect = [r[0], r[3] - NOTE_SIZE, r[0] + NOTE_SIZE, r[3]]
  const irt = parent.ref
  if (!irt) throw new Error('This annotation cannot be replied to.')
  const { ref } = createAnnot(pdf, pageOf(parent), {
    ...o,
    subtype: 'Text',
    rect,
    contents,
    flags: FLAG_REPLY,
    extra: { IRT: irt, RT: 'R', Name: 'Comment', ...extra }
  })
  return refId(ref)
}

/** A reply is a Text annotation with /IRT pointing at the parent and /RT /R, shown as a thread by readers. */
export function addReply(pdf: PDFDocument, parentId: string, o: Who & { text: string }): string {
  const parent = locate(pdf, parentId)
  if (!parent) throw new Error('The comment no longer exists.')
  return replyBase(pdf, parent, o, {}, o.text)
}

export const REVIEW_STATES: ReviewState[] = ['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']

/**
 * Sets the review state (Acrobat style): a state-change annotation is added as a reply carrying
 * /StateModel /Review and /State; the newest one wins.
 */
export function setReviewState(pdf: PDFDocument, id: string, state: ReviewState, o: Who): string {
  const parent = locate(pdf, id)
  if (!parent) throw new Error('The comment no longer exists.')
  return replyBase(
    pdf,
    parent,
    o,
    { StateModel: PDFString.of('Review'), State: PDFString.of(state), Name: 'Note' },
    state === 'None' ? `Marked None by ${o.author}` : `${state} set by ${o.author}`
  )
}

// ---------------------------------------------------------------- editing

export interface Patch {
  contents?: string
  color?: number[]
  fill?: number[] | null
  opacity?: number
  borderWidth?: number
  dashed?: boolean
  fontSize?: number
  icon?: 'Note' | 'Comment'
}

const touch = (dict: PDFDict, now = new Date()): void => {
  dict.set(PDFName.of('M'), PDFString.of(formatPdfDate(now)))
}

function need(pdf: PDFDocument, id: string): Located {
  const loc = locate(pdf, id)
  if (!loc) throw new Error('The annotation no longer exists.')
  return loc
}

export async function updateAnnotation(pdf: PDFDocument, id: string, patch: Patch, who?: { now?: Date }): Promise<void> {
  const loc = need(pdf, id)
  const d = loc.dict
  const ctx = pdf.context
  const info = infoOfDict(d)
  if (!info) throw new Error('This annotation cannot be edited.')
  const caps = capabilities(info)
  let redraw = false
  const rotation = getDict(d, 'AP') ? apRotation(d) : geomOfPage(loc.page).rotation

  if (patch.contents !== undefined) {
    d.set(PDFName.of('Contents'), text(patch.contents))
    d.delete(PDFName.of('RC')) // stale rich text would win over the new plain text in Acrobat
    if (info.subtype === 'FreeText') redraw = true
  }
  if (patch.color && caps.recolor) {
    const c = sanitizeColor(patch.color)
    if (info.subtype === 'FreeText') d.set(PDFName.of('DA'), PDFString.of(daString(c, patch.fontSize ?? info.fontSize)))
    else setNumbers(ctx, d, 'C', c)
    redraw = true
  }
  if (patch.fontSize !== undefined && info.subtype === 'FreeText') {
    const c = patch.color ? sanitizeColor(patch.color) : sanitizeColor(info.color, [0, 0, 0])
    d.set(PDFName.of('DA'), PDFString.of(daString(c, Math.min(96, Math.max(4, patch.fontSize)))))
    redraw = true
  }
  if (patch.fill !== undefined && caps.fill) {
    const k = info.subtype === 'FreeText' ? 'C' : 'IC'
    if (patch.fill === null || patch.fill.length === 0) d.delete(PDFName.of(k))
    else setNumbers(ctx, d, k, sanitizeColor(patch.fill))
    redraw = true
  }
  if (patch.opacity !== undefined && caps.opacity) {
    const o = clampOpacity(patch.opacity)
    if (o < 1) d.set(PDFName.of('CA'), PDFNumber.of(o))
    else d.delete(PDFName.of('CA'))
    redraw = true
  }
  if ((patch.borderWidth !== undefined || patch.dashed !== undefined) && caps.width) {
    const bs = getDict(d, 'BS') ?? ctx.obj({ Type: 'Border' })
    if (patch.borderWidth !== undefined) bs.set(PDFName.of('W'), PDFNumber.of(Math.max(0, patch.borderWidth)))
    if (patch.dashed !== undefined) {
      bs.set(PDFName.of('S'), PDFName.of(patch.dashed ? 'D' : 'S'))
      if (patch.dashed) bs.set(PDFName.of('D'), ctx.obj([3, 2]))
      else bs.delete(PDFName.of('D'))
    }
    d.set(PDFName.of('BS'), bs)
    redraw = true
  }
  if (patch.icon && info.subtype === 'Text') {
    d.set(PDFName.of('Name'), PDFName.of(patch.icon))
    redraw = true
  }
  if (redraw && info.subtype === 'FreeText') await growToFit(pdf, d, rotation)
  touch(d, who?.now)
  if (redraw) await regenerateAppearance(pdf, d, rotation)
}

/** Makes a FreeText rect tall enough for its text (never shrinks it). */
async function growToFit(pdf: PDFDocument, d: PDFDict, rotation: number): Promise<void> {
  const info = infoOfDict(d)
  if (!info) return
  const [w, h] = uprightSize(info.rect, rotation)
  const needed = await freeTextNeededHeight(pdf, info.contents, w, info.fontSize, Math.max(0, info.borderWidth))
  if (needed > h) setNumbers(pdf.context, d, 'Rect', growRectDown(info.rect, rotation, needed - h))
}

const translateFlat = (v: number[], dx: number, dy: number): number[] => v.map((n, i) => (i % 2 === 0 ? n + dx : n + dy))

/** Moves an annotation: /Rect and every geometry entry move together, so all readers agree. */
export function moveAnnotation(pdf: PDFDocument, id: string, dx: number, dy: number, who?: { now?: Date }): void {
  const loc = need(pdf, id)
  const d = loc.dict
  const ctx = pdf.context
  const rect = getNumbers(d, 'Rect')
  if (!rect) throw new Error('This annotation has no position.')
  setNumbers(ctx, d, 'Rect', translateFlat(rect, dx, dy))
  for (const k of ['QuadPoints', 'L', 'Vertices', 'CL']) {
    const v = getNumbers(d, k)
    if (v) setNumbers(ctx, d, k, translateFlat(v, dx, dy))
  }
  const ink = getNumberArrays(d, 'InkList')
  if (ink) d.set(PDFName.of('InkList'), ctx.obj(ink.map((s) => numbers(ctx, translateFlat(s, dx, dy)))))
  touch(d, who?.now)
}

/** Resizes to `newRect` (PDF space). Only meaningful for boxes, ellipses, text boxes, drawings and stamps. */
export async function resizeAnnotation(pdf: PDFDocument, id: string, newRect: Rect, who?: { now?: Date }): Promise<void> {
  const loc = need(pdf, id)
  const d = loc.dict
  const ctx = pdf.context
  const info = infoOfDict(d)
  if (!info || !capabilities(info).resize) throw new Error('This annotation cannot be resized.')
  const old = info.rect
  const nr = normalizeRect(newRect)
  if (rectWidth(nr) < 4 || rectHeight(nr) < 4) throw new Error('That size is too small.')
  const sx = rectWidth(nr) / (rectWidth(old) || 1)
  const sy = rectHeight(nr) / (rectHeight(old) || 1)
  setNumbers(ctx, d, 'Rect', nr)
  if (info.subtype === 'Ink') {
    const map = (s: number[]): number[] => s.map((v, i) => (i % 2 === 0 ? nr[0] + (v - old[0]) * sx : nr[1] + (v - old[1]) * sy))
    d.set(PDFName.of('InkList'), ctx.obj(info.ink.map((s) => numbers(ctx, map(s)))))
  }
  touch(d, who?.now)
  if (info.ours || !info.hasAppearance) {
    const rotation = getDict(d, 'AP') ? apRotation(d) : geomOfPage(loc.page).rotation
    if (info.subtype === 'FreeText') await growToFit(pdf, d, rotation)
    await regenerateAppearance(pdf, d, rotation)
  }
}

// ---------------------------------------------------------------- deleting

/** Number of replies (including state changes) below an annotation, for "delete thread?" confirmations. */
export function countReplies(pdf: PDFDocument, id: string): number {
  return descendantIds(listLocated(pdf), id).length
}

/** Deletes an annotation with its replies, its popup and (when it is ours) its appearance stream. */
export function deleteAnnotation(pdf: PDFDocument, id: string): void {
  const all = listLocated(pdf)
  const target = all.find((l) => l.id === id)
  if (!target) throw new Error('The annotation no longer exists.')
  const ids = new Set([id, ...descendantIds(all, id)])
  const victims = all.filter((l) => ids.has(l.id))
  const popups = new Set<string>()
  for (const v of victims) {
    const popup = v.dict.get(PDFName.of('Popup'))
    if (popup instanceof PDFRef) popups.add(refId(popup))
    if (isOurName(infoOfDict(v.dict)?.name)) {
      const ap = getDict(v.dict, 'AP')
      const n = ap?.get(PDFName.of('N'))
      if (n instanceof PDFRef) pdf.context.delete(n)
    }
  }
  const popupLocs = all.filter((l) => popups.has(l.id) && getName(l.dict, 'Subtype') === 'Popup')
  removeLocated(pdf, [...victims, ...popupLocs])
}
